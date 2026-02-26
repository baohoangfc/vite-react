import { buildHealthPayload } from '../shared/backend-payloads.mjs'

const ENVIRONMENT = 'vercel-function'

export default function handler(_req, res) {
  res.status(200).json(buildHealthPayload(ENVIRONMENT))
}
