const path = require('node:path');
module.exports = {
  appId:'io.fanclan.streamsnipe', productName:'StreamSnipe', directories:{output:'../artifacts'},
  files:['main.cjs','engine.cjs','security.cjs','icon.png','config.json','package.json'],
  extraResources:[{from:'../staging/engine',to:'engine'},{from:'../staging/dashboard',to:'dashboard'},{from:'../staging/tools',to:'tools'},{from:'../staging/integrity.json',to:'integrity.json'},{from:'../staging/licenses',to:'licenses'}],
  asar:true, npmRebuild:false, forceCodeSigning:process.env.STREAMSNIPE_STABLE === '1',
  mac:{category:'public.app-category.video', target:['dmg','zip'], minimumSystemVersion:'13.0', identity:process.env.CSC_LINK ? undefined : null, sign:process.env.STREAMSNIPE_STABLE === '1' ? require('./sign.cjs') : undefined, notarize:process.env.STREAMSNIPE_STABLE === '1'},
  win:{target:['nsis'], signAndEditExecutable:!!process.env.WIN_CSC_LINK},
  nsis:{oneClick:false, allowToChangeInstallationDirectory:true}
};
