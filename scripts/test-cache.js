#!/usr/bin/env node
import cache from '../lib/cache.js';

async function main() {
  console.log('Cache test starting...');
  await cache.init();
  console.log('Backend:', cache.backend());
  console.log('isRedis:', cache.isRedis());

  await cache.set('cache:test:key1', 'value1', 2);
  await cache.set('cache:test:key2', 'value2', 5);

  const v1 = await cache.get('cache:test:key1');
  const v2 = await cache.get('cache:test:key2');
  console.log('get key1:', v1);
  console.log('get key2:', v2);

  const m = await cache.mget(['cache:test:key1', 'cache:test:key2', 'cache:test:missing']);
  console.log('mget result:', m);

  console.log('Sleeping 3s to test TTL...');
  await new Promise((r) => setTimeout(r, 3000));
  const v1b = await cache.get('cache:test:key1');
  const v2b = await cache.get('cache:test:key2');
  console.log('after 3s get key1 (should be null):', v1b);
  console.log('after 3s get key2 (should still exist):', v2b);

  console.log('Cache test finished.');
}

main().catch((e) => {
  console.error('Cache test failed:', e?.message || e);
  process.exit(1);
});
