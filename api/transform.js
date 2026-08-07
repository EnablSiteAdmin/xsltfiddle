const xslt3 = require('xslt3');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed. Use POST.' });
  }

  try {
    const { source, xslt } = req.body || {};

    if (!source || !xslt) {
      return res.status(400).json({
        ok: false,
        error: 'Parameters "source" en "xslt" zijn verplicht.'
      });
    }

    const api = xslt3.stateless({
      sourceText: source,
      xsltText: xslt,
      destination: 'serialized'
    });

    const output = await new Promise((resolve, reject) => {
      api.then(processor => {
        try {
          const result = processor.transform();
          resolve(result);
        } catch (err) {
          reject(err);
        }
      }).catch(reject);
    });

    return res.status(200).json({
      ok: true,
      output: output
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
};