import { spawn } from 'node:child_process'

const run = (command, args, name) => {
  const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' })

  child.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`${name} exited with code ${code}`)
      process.exitCode = code
    }
  })

  return child
}

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const backend = run(npmCmd, ['run', 'dev:backend'], 'backend')
const frontend = run(npmCmd, ['run', 'dev:frontend'], 'frontend')

const shutdown = () => {
  backend.kill('SIGTERM')
  frontend.kill('SIGTERM')
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
