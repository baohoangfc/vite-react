import { buildHealthPayload } from '../shared/backend-payloads.mjs'

export default function handler(_req, res) {
  res.status(200).json(buildHealthPayload('vercel-function'))
}
