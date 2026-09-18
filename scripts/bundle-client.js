import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const clientPath = join(process.cwd(), 'lib', 'client.js')
try {
  let content = readFileSync(clientPath, 'utf8')
  // Strip ESM export {} so classic script tag in DSH client-modules doesn't fail
  content = content.replace(/export\s*\{\s*\};?/g, '')
  writeFileSync(clientPath, content, 'utf8')
  console.log('[bundle-client] Successfully cleaned lib/client.js for DSH ModuleLoader')
} catch (err) {
  console.error('[bundle-client] Failed to process lib/client.js:', err)
}
