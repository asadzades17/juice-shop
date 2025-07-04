import fs from 'node:fs'
import yaml from 'js-yaml'
import { type NextFunction, type Request, type Response } from 'express'

import * as accuracy from '../lib/accuracy'
import * as challengeUtils from '../lib/challengeUtils'
import { type ChallengeKey } from 'models/challenge'

const FixesDir = 'data/static/codefixes'

interface CodeFix {
  fixes: string[]
  correct: number
}

type Cache = Record<string, CodeFix>

const CodeFixes: Cache = {}

export const readFixes = (key: string): CodeFix => {
  if (CodeFixes[key]) {
    return CodeFixes[key]
  }
  const files = fs.readdirSync(FixesDir)
  const fixes: string[] = []
  let correct: number = -1
  for (const file of files) {
    if (file.startsWith(`${key}_`)) {
      const fix = fs.readFileSync(`${FixesDir}/${file}`).toString()
      const metadata = file.split('_')
      const number = metadata[1]
      fixes.push(fix)
      if (metadata.length === 3) {
        correct = parseInt(number, 10)
        correct--
      }
    }
  }

  CodeFixes[key] = {
    fixes,
    correct
  }
  return CodeFixes[key]
}

interface FixesRequestParams {
  key: string
}

interface VerdictRequestBody {
  key: ChallengeKey
  selectedFix: number
}

export const serveCodeFixes = () => (
  req: Request<FixesRequestParams, Record<string, unknown>, Record<string, unknown>>,
  res: Response,
  next: NextFunction
) => {
  const key = req.params.key
  const fixData = readFixes(key)
  if (fixData.fixes.length === 0) {
    res.status(404).json({
      error: 'No fixes found for the snippet!'
    })
    return
  }
  res.status(200).json({
    fixes: fixData.fixes
  })
}

export const checkCorrectFix = () => async (
  req: Request<Record<string, unknown>, Record<string, unknown>, VerdictRequestBody>,
  res: Response,
  next: NextFunction
) => {
  const key = req.body.key
  const selectedFix = req.body.selectedFix
  const fixData = readFixes(key)

  if (fixData.fixes.length === 0) {
    res.status(404).json({
      error: 'No fixes found for the snippet!'
    })
    return
  }

  let explanation: string | undefined

  const infoFilePath = `${FixesDir}/${key}.info.yml`
  if (fs.existsSync(infoFilePath)) {
    const codingChallengeInfos = yaml.load(
      fs.readFileSync(infoFilePath, 'utf8')
    ) as {
      fixes: {
        id: number
        explanation?: string
      }[]
    }

    const selectedFixInfo = codingChallengeInfos.fixes.find(({ id }) => id === selectedFix + 1)
    if (selectedFixInfo?.explanation) {
      explanation = res.__(selectedFixInfo.explanation)
    }
  }

  if (selectedFix === fixData.correct) {
    await challengeUtils.solveFixIt(key)
    res.status(200).json({
      verdict: true,
      explanation
    })
  } else {
    accuracy.storeFixItVerdict(key, false)
    res.status(200).json({
      verdict: false,
      explanation
    })
  }
}
