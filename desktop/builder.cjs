const path = require('node:path');
module.exports = {
  appId:'io.fanclan.fansnipe', productName:'FanSnipe', directories:{output:'../artifacts'},
  files:['main.cjs','engine.cjs','security.cjs','data-paths.cjs','icon.png','config.json','package.json'],
  extraResources:[{from:'../staging/engine',to:'engine'},{from:'../staging/engine/node_modules',to:'engine/node_modules'},{from:'../staging/dashboard',to:'dashboard'},{from:'../staging/tools',to:'tools'},{from:'../staging/integrity.json',to:'integrity.json'},{from:'../staging/licenses',to:'licenses'}],
  asar:true, npmRebuild:false, forceCodeSigning:(process.env.FANSNIPE_STABLE || process.env.STREAMSNIPE_STABLE) === '1',
  mac:{category:'public.app-category.video', target:['dmg','zip'], minimumSystemVersion:'13.0', identity:process.env.CSC_LINK ? undefined : null, sign:(process.env.FANSNIPE_STABLE || process.env.STREAMSNIPE_STABLE) === '1' ? require('./sign.cjs') : undefined, notarize:(process.env.FANSNIPE_STABLE || process.env.STREAMSNIPE_STABLE) === '1'},
  win:{target:['nsis'], signAndEditExecutable:!!process.env.WIN_CSC_LINK},
  nsis:{oneClick:false, allowToChangeInstallationDirectory:true}
};
