// Mounted only by the test entry; never copied into the product image.
const { readdir } = require('node:fs/promises');
const { createBrowserReadinessProbe } = require('/app/apps/api/dist/runtime/browser-readiness-probe.js');

(async () => {
  const probe = createBrowserReadinessProbe();
  for (let iteration = 1; iteration <= 200; iteration++) {
    await probe('/usr/bin/chromium');
    const roots = (await readdir('/tmp')).filter(name => name.startsWith('global-browser-probe-'));
    if (roots.length !== 0) throw new Error('BROWSER_PROBE_STATE_LEAK');
  }
  console.log('BROWSER_PROBE_OCI_SMOKE_PASSED iterations=200 roots=0');
})().catch(() => {
  console.error('BROWSER_PROBE_OCI_SMOKE_FAILED');
  process.exitCode = 1;
});
