const test=require('node:test');const assert=require('node:assert/strict');
test('copies engine production dependencies as an explicit resource root',()=>{
  const config=require('../builder.cjs');
  assert.ok(config.extraResources.some(item=>item.from==='../staging/engine/node_modules'&&item.to==='engine/node_modules'));
});
