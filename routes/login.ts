/*
 * Copyright (c) 2014-2025 Bjoern Kimminich & the OWASP Juice Shop contributors.
 * SPDX-License-Identifier: MIT
 */
import { type Request, type Response, type NextFunction } from 'express'
import config from 'config'

import * as challengeUtils from '../lib/challengeUtils'
import { challenges, users } from '../data/datacache'
import { BasketModel } from '../models/basket'
import * as security from '../lib/insecurity'
import { UserModel } from '../models/user'
import { type User } from '../data/types'
import * as utils from '../lib/utils'

export function login () {
  function afterLogin (user: { data: User, bid: number }, res: Response, next: NextFunction) {
    verifyPostLoginChallenges(user)
    BasketModel.findOrCreate({ where: { UserId: user.data.id } })
      .then(([basket]: [BasketModel, boolean]) => {
        const token = security.authorize(user)
        user.bid = basket.id
        security.authenticatedUsers.put(token, user)
        res.json({ authentication: { token, bid: basket.id, umail: user.data.email } })
      }).catch((error: Error) => {
        next(error)
      })
  }

  // In-memory failed login tracker (for demonstration; use persistent store in prod)
  const FAILED_ATTEMPTS_LIMIT = 5
  const LOCK_TIME_MS = 15 * 60 * 1000 // 15 minutes
  const failedLoginAttempts: Record<string, { count: number, lastAttempt: number }> = {}
  return async (req: Request, res: Response, next: NextFunction) => {
    const email = req.body.email || ''
    const key = `${email}:${req.ip}`
    const now = Date.now()
    if (failedLoginAttempts[key] && failedLoginAttempts[key].count >= FAILED_ATTEMPTS_LIMIT) {
      if (now - failedLoginAttempts[key].lastAttempt < LOCK_TIME_MS) {
        res.status(429).send(res.__('Too many failed login attempts. Please try again later.'))
        return
      } else {
        // Reset after lock time passed
        delete failedLoginAttempts[key]
      }
    }
    try {
      verifyPreLoginChallenges(req)

      const email = req.body.email || ''
      const hashedPassword = await security.hashPassword(req.body.password || '')

      const authenticatedUser = await UserModel.findOne({
        where: {
          email,
          password: hashedPassword
        }
        // НЕ добавляем deletedAt: null — Sequelize сам исключает soft-deleted записи при paranoid: true
      })

      const user = utils.queryResultToJson(authenticatedUser)

      if (user.data?.id && user.data.totpSecret !== '') {
        if (failedLoginAttempts[key]) { delete failedLoginAttempts[key] }
        res.status(401).json({
          status: 'totp_token_required',
          data: {
            tmpToken: security.authorize({
              userId: user.data.id,
              type: 'password_valid_needs_second_factor_token'
            })
          }
        })
      } else if (user.data?.id) {
        if (failedLoginAttempts[key]) { delete failedLoginAttempts[key] }
        // @ts-expect-error FIXME some properties missing in user
        afterLogin(user, res, next)
      } else {
        if (!failedLoginAttempts[key]) {
          failedLoginAttempts[key] = { count: 1, lastAttempt: now }
        } else {
          failedLoginAttempts[key].count += 1
          failedLoginAttempts[key].lastAttempt = now
        }
        res.status(401).send(res.__('Invalid email or password.'))
      }
    } catch (error) {
      next(error)
    }
  }

  function verifyPreLoginChallenges (req: Request) {
    challengeUtils.solveIf(challenges.weakPasswordChallenge, () =>
      req.body.email === 'admin@' + config.get<string>('application.domain') &&
      req.body.password === 'admin123')

    challengeUtils.solveIf(challenges.loginSupportChallenge, () =>
      req.body.email === 'support@' + config.get<string>('application.domain') &&
      req.body.password === 'J6aVjTgOpRs@?5l!Zkq2AYnCE@RF$P')

    challengeUtils.solveIf(challenges.loginRapperChallenge, () =>
      req.body.email === 'mc.safesearch@' + config.get<string>('application.domain') &&
      req.body.password === 'Mr. N00dles')

    challengeUtils.solveIf(challenges.loginAmyChallenge, () =>
      req.body.email === 'amy@' + config.get<string>('application.domain') &&
      req.body.password === 'K1f.....................')

    challengeUtils.solveIf(challenges.dlpPasswordSprayingChallenge, () =>
      req.body.email === 'J12934@' + config.get<string>('application.domain') &&
      req.body.password === '0Y8rMnww$*9VFYE§59-!Fg1L6t&6lB')

    challengeUtils.solveIf(challenges.oauthUserPasswordChallenge, () =>
      req.body.email === 'bjoern.kimminich@gmail.com' &&
      req.body.password === config.get('oauthUser.password'))

    challengeUtils.solveIf(challenges.exposedCredentialsChallenge, () =>
      req.body.email === 'testing@' + config.get<string>('application.domain') &&
      req.body.password === 'IamUsedForTesting')
  }

  function verifyPostLoginChallenges (user: { data: User }) {
    challengeUtils.solveIf(challenges.loginAdminChallenge, () =>
      user.data.id === users.admin.id)

    challengeUtils.solveIf(challenges.loginJimChallenge, () =>
      user.data.id === users.jim.id)

    challengeUtils.solveIf(challenges.loginBenderChallenge, () =>
      user.data.id === users.bender.id)

    challengeUtils.solveIf(challenges.ghostLoginChallenge, () =>
      user.data.id === users.chris.id)

    if (
      challengeUtils.notSolved(challenges.ephemeralAccountantChallenge) &&
      user.data.email === 'acc0unt4nt@' + config.get<string>('application.domain') &&
      user.data.role === 'accounting'
    ) {
      UserModel.count({
        where: {
          email: 'acc0unt4nt@' + config.get<string>('application.domain')
        }
      }).then((count: number) => {
        if (count === 0) {
          challengeUtils.solve(challenges.ephemeralAccountantChallenge)
        }
      }).catch(() => {
        throw new Error('Unable to verify challenges! Try again')
      })
    }
  }
}
