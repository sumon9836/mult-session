#!/usr/bin/env node
import cache from '../lib/cache.js';
import config from '../config.js';
import { personalDB, groupDB } from '../lib/database/index.js';
import { loadPlugins, commands } from '../lib/plugins.js';

async function main() {
  console.log('Starting DB + plugins test...');
  await cache.init();
  console.log('Cache ready:', cache.isReady());
  console.log('DB dialect:', config.DATABASE.getDialect());

  const bot = '99999';
  console.log('\n--- personalDB set/get test ---');
  const setRes = await personalDB(['autotyping'], { content: 'true' }, 'set', bot);
  console.log('personalDB set result:', setRes);
  const got = await personalDB(['autotyping', 'autoread'], {}, 'get', bot);
  console.log('personalDB get result:', got);

  console.log('\n--- groupDB set/get test ---');
  const gid = '99999-999@g.us';
  const gset = await groupDB(['welcome'], { jid: gid, content: { status: 'true', message: 'hello from test' } }, 'set');
  console.log('groupDB set result:', gset);
  const gget = await groupDB(['welcome', 'exit'], { jid: gid }, 'get');
  console.log('groupDB get result:', gget);

  console.log('\n--- plugins load test ---');
  const loaded = await loadPlugins();
  console.log('loadPlugins returned count:', loaded.length);
  console.log('commands (first 10):', commands.slice(0, 10).map((c) => c.command));

  console.log('\nTest script finished.');
}

main().catch((e) => {
  console.error('Test failed:', e?.message || e);
  process.exit(1);
});
