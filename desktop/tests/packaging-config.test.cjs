const test=require('node:test');const assert=require('node:assert/strict');
test('copies engine production dependencies as an explicit resource root',()=>{
  const config=require('../builder.cjs');
  assert.ok(config.extraResources.some(item=>item.from==='../staging/engine/node_modules'&&item.to==='engine/node_modules'));
});
test('uses FanSnipe product identity and bundles data-path resolver',()=>{
  const config=require('../builder.cjs');assert.equal(config.productName,'FanSnipe');assert.equal(config.appId,'io.fanclan.fansnipe');assert.ok(config.files.includes('data-paths.cjs'));
});
