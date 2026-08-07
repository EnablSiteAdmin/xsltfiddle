const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Statisch resolven zodat Vercel's bundler het pakket meeneemt in de deployment.
const XSLT3_JS = require.resolve('xslt3/xslt3.js');

const MAX_INPUT = 2 * 1024 * 1024;   // 2 MB per veld
const TIMEOUT_MS = 20000;

function checkPassword(req) {
  const expected = process.env.FIDDLE_PASSWORD;

  // Faalt dicht: zonder ingesteld wachtwoord doet de functie niets.
  if (!expected) {
    return { status: 503, error: 'FIDDLE_PASSWORD is niet ingesteld in de Vercel-omgevingsvariabelen.' };
  }

  const given = String(req.headers['x-fiddle-password'] || '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);

  // Hash beide kanten zodat timingSafeEqual altijd gelijke lengtes krijgt en
  // de lengte van het wachtwoord niet uit de responstijd valt af te leiden.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();

  if (!crypto.timingSafeEqual(ha, hb)) {
    return { status: 401, error: 'Onjuist wachtwoord.' };
  }
  return null;
}

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
          return resolve({ ok: false, error: scrub(stderr || err.message), partial: stdout || '' });
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

  const bad = checkPassword(req);
  if (bad) return res.status(bad.status).json({ ok: false, error: bad.error, auth: true });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }

  // Alleen het wachtwoord controleren: geen proces starten, dus snel.
  if (body && body.verify === true) {
    return res.status(200).json({ ok: true, verified: true });
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