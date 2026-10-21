import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
if (process.env.GITHUB_REF_NAME !== 'v'.concat(manifest.version))
  throw new Error('The release tag must match the package version.')
