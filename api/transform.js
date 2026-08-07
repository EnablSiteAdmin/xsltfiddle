const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Statisch resolven zodat Vercel's bundler het pakket meeneemt in de deployment.
const XSLT3_JS = require.resolve('xslt3/xslt3.js');

const MAX_INPUT = 2 * 1024 * 1024;   // 2 MB per veld
const TIMEOUT_MS = 20000;

function runTransform(sourceText, xsltText) {
  return new Promise(resolve => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-'));
    const srcFile = path.join(dir, 'source.xml');
    const xslFile = path.join(dir, 'map.xslt');
    const scrub = s => String(s).replace(
      new RegExp(dir.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&'), 'g'), '');

    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };

    try {
      fs.writeFileSync(srcFile, sourceText, 'utf8');
      fs.writeFileSync(xslFile, xsltText, 'utf8');
    } catch (e) {
      cleanup();
      return resolve({ ok: false, error: 'Kon tijdelijke bestanden niet schrijven: ' + e.message });
    }

    execFile(
      process.execPath,
      [XSLT3_JS, '-s:' + srcFile, '-xsl:' + xslFile],
      { maxBuffer: 32 * 1024 * 1024, timeout: TIMEOUT_MS, cwd: dir },
      (err, stdout, stderr) => {
        cleanup();
        if (err && err.killed) {
          return resolve({ ok: false, error: 'Transformatie afgebroken na ' + (TIMEOUT_MS / 1000) + ' seconden.' });
        }
        if (err) {
          return resolve({
            ok: false,
            error: scrub(stderr || err.message),
            partial: stdout || ''
          });
        }
        resolve({ ok: true, output: stdout, warnings: stderr ? scrub(stderr) : '' });
      }
    );
  });
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Gebruik POST.' });
  }

  // Gedeeld geheim. Zonder dit draait iedereen die de URL kent willekeurige
  // XSLT op jouw functie - inclusief doc() en unparsed-text() naar interne adressen.
  const secret = process.env.FIDDLE_TOKEN;
  if (secret) {
    const given = req.headers['x-fiddle-token'] || '';
    const a = Buffer.from(String(given));
    const b = Buffer.from(secret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ ok: false, error: 'Ongeldig of ontbrekend token.' });
    }
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const source = body && body.source;
  const xslt = body && body.xslt;

  if (!source || !xslt) {
    return res.status(400).json({ ok: false, error: 'Parameters "source" en "xslt" zijn verplicht.' });
  }
  if (source.length > MAX_INPUT || xslt.length > MAX_INPUT) {
    return res.status(413).json({ ok: false, error: 'Invoer te groot (max 2 MB per veld).' });
  }

  try {
    return res.status(200).json(await runTransform(source, xslt));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
};