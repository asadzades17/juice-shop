/*
 * Copyright (c) 2014-2025 Bjoern Kimminich & the OWASP Juice Shop contributors.
 * SPDX-License-Identifier: MIT
 */

import config from 'config'
import { type Request, type Response } from 'express'
import { BasketModel } from '../models/basket'
import { UserModel } from '../models/user'
import * as challengeUtils from '../lib/challengeUtils'
import * as utils from '../lib/utils'
import { challenges } from '../data/datacache'
import * as otplib from 'otplib'
import * as security from '../lib/insecurity'

otplib.authenticator.options = {
  // Accepts tokens as valid even when they are 30sec to old or to new
  // This is a standard as the clocks of the authenticator and server might not align perfectly.
  window: 1
}

export async function verify (req: Request, res: Response) {
  const { tmpToken, totpToken } = req.body

  try {
    const { userId, type } = security.verify(tmpToken) && security.decode(tmpToken)

    if (type !== 'password_valid_needs_second_factor_token') {
      throw new Error('Invalid token type')
    }

    const user = await UserModel.findByPk(userId)
    if (user == null) {
      throw new Error('No such user found!')
    }

    const isValid = otplib.authenticator.check(totpToken, user.totpSecret)

    const plainUser = utils.queryResultToJson(user)

    if (!isValid) {
      return res.status(401).send()
    }
    challengeUtils.solveIf(challenges.twoFactorAuthUnsafeSecretStorageChallenge, () => { return user.email === 'wurstbrot@' + config.get<string>('application.domain') })

    const [basket] = await BasketModel.findOrCreate({ where: { UserId: userId } })

    const token = security.authorize(plainUser)
    // @ts-expect-error FIXME set new property for original basket
    plainUser.bid = basket.id // keep track of original basket for challenge solution check
    security.authenticatedUsers.put(token, plainUser)

    res.json({ authentication: { token, bid: basket.id, umail: user.email } })
  } catch (error) {
    res.status(401).send()
  }
}

/**
 * Check the 2FA status of the currently signed-in user.
 *
 * When 2FA is not set up, the result will include data required to start the setup.
 */
export async function status (req: Request, res: Response) {
  try {
    const data = security.authenticatedUsers.from(req)
    if (!data) {
      throw new Error('You need to be logged in to see this')
    }
    const { data: user } = data

    if (user.totpSecret === '') {
      const secret = otplib.authenticator.generateSecret()

      res.json({
        setup: false,
        secret,
        email: user.email,
        setupToken: security.authorize({
          secret,
          type: 'totp_setup_secret'
        })
      })
    } else {
      res.json({
        setup: true
      })
    }
  } catch (error) {
    res.status(401).send()
  }
}

/**
 * Sets Up 2FA for a User
 * Requires 3 params:
 * 1. The Users Password as a confirmation.
 * 2. A Setup token. This is returned by the status endpoint.
 *    This contains a signed TOTP secret to ensure that the secret
 *    was generated by the server and wasn't tampered with by the client
 * 3. The first TOTP Token, generated by the TOTP App. (e.g. Google Authenticator)
 */
export async function setup (req: Request, res: Response) {
  try {
    const data = security.authenticatedUsers.from(req)
    if (!data) {
      throw new Error('Need to login before setting up 2FA')
    }
    const { data: user } = data

    const { password, setupToken, initialToken } = req.body

    if (!security.constantTimeCompare(user.password, security.hash(password))) {
      throw new Error('Password doesnt match stored password')
    }

    if (user.totpSecret !== '') {
      throw new Error('User has 2fa already setup')
    }

    const { secret, type } = security.verify(setupToken) && security.decode(setupToken)
    if (type !== 'totp_setup_secret') {
      throw new Error('SetupToken is of wrong type')
    }
    if (!otplib.authenticator.check(initialToken, secret)) {
      throw new Error('Initial token doesnt match the secret from the setupToken')
    }

    // Update db model and cached object
    const userModel = await UserModel.findByPk(user.id)
    if (userModel == null) {
      throw new Error('No such user found!')
    }

    userModel.totpSecret = secret
    await userModel.save()
    security.authenticatedUsers.updateFrom(req, utils.queryResultToJson(userModel))

    res.status(200).send()
  } catch (error) {
    res.status(401).send()
  }
}

/**
 * Disables 2fa for the current user
 */
export async function disable (req: Request, res: Response) {
  try {
    const data = security.authenticatedUsers.from(req)
    if (!data) {
      throw new Error('Need to login before setting up 2FA')
    }
    const { data: user } = data

    const { password } = req.body

    if (user.password !== security.hash(password)) {
      throw new Error('Password doesnt match stored password')
    }

    // Update db model and cached object
    const userModel = await UserModel.findByPk(user.id)
    if (userModel == null) {
      throw new Error('No such user found!')
    }

    userModel.totpSecret = ''
    await userModel.save()
    security.authenticatedUsers.updateFrom(req, utils.queryResultToJson(userModel))

    res.status(200).send()
  } catch (error) {
    res.status(401).send()
  }
}
