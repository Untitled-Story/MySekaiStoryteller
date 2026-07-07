import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')
const tauriConfigPath = resolve(projectRoot, 'src-tauri/tauri.conf.json')

function main() {
  const identifier = readAppIdentifier()
  const appDataDir = resolveAppDataDir(identifier)
  const configPath = join(appDataDir, 'config.json')

  if (!existsSync(configPath)) {
    console.log(`No settings file found at ${configPath}`)
    return
  }

  rmSync(configPath)
  console.log(`Deleted settings file: ${configPath}`)
  console.log(`Project data is untouched: ${join(appDataDir, 'projects')}`)
}

function readAppIdentifier() {
  const rawConfig = readFileSync(tauriConfigPath, 'utf8')
  const config = JSON.parse(rawConfig)

  if (typeof config.identifier !== 'string' || config.identifier.length === 0) {
    throw new Error(`Missing identifier in ${tauriConfigPath}`)
  }

  return config.identifier
}

function resolveAppDataDir(identifier) {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', identifier)
  }

  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), identifier)
  }

  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), identifier)
}

main()
