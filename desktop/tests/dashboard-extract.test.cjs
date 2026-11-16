const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('extracts locked dashboard while ignoring macOS AppleDouble metadata',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-'));try{
  const py=`import tarfile,io,json,hashlib,sys,os\nd=sys.argv[1]; f=b'<html></html>'; t=tarfile.open(os.path.join(d,'a.tar.gz'),'w:gz')\nfor name,data in [('._.',b'meta'),('._index.html',b'meta'),('index.html',f)]:\n i=tarfile.TarInfo(name);i.size=len(data);t.addfile(i,io.BytesIO(data))\nt.close(); b=open(os.path.join(d,'a.tar.gz'),'rb').read();json.dump({'archiveSha256':hashlib.sha256(b).hexdigest(),'files':{'index.html':hashlib.sha256(f).hexdigest()}},open(os.path.join(d,'lock.json'),'w'))`;
  assert.equal(spawnSync('python3',['-c',py,dir]).status,0);const r=spawnSync('python3',[path.resolve(__dirname,'../../scripts/packaging-dashboard-extract.py'),path.join(dir,'a.tar.gz'),path.join(dir,'out'),path.join(dir,'lock.json')],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.deepEqual(fs.readdirSync(path.join(dir,'out')),['index.html']);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('rejects unexpected files, links, and traversal even with a matching archive hash',()=>{
 for(const kind of ['extra','symlink','traversal']){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-bad-'));try{
   const py=`import tarfile,io,json,hashlib,sys,os\nd,kind=sys.argv[1:];t=tarfile.open(os.path.join(d,'a.tar.gz'),'w:gz'); f=b'ok';i=tarfile.TarInfo('index.html');i.size=len(f);t.addfile(i,io.BytesIO(f))\ni=tarfile.TarInfo({'extra':'extra.js','symlink':'index-link','traversal':'../escape'}[kind]);i.type=tarfile.SYMTYPE if kind=='symlink' else tarfile.REGTYPE;i.linkname='index.html' if kind=='symlink' else '';i.size=0;t.addfile(i);t.close();b=open(os.path.join(d,'a.tar.gz'),'rb').read();json.dump({'archiveSha256':hashlib.sha256(b).hexdigest(),'files':{'index.html':hashlib.sha256(f).hexdigest()}},open(os.path.join(d,'lock.json'),'w'))`;
   assert.equal(spawnSync('python3',['-c',py,dir,kind]).status,0);const r=spawnSync('python3',[path.resolve(__dirname,'../../scripts/packaging-dashboard-extract.py'),path.join(dir,'a.tar.gz'),path.join(dir,'out'),path.join(dir,'lock.json')],{encoding:'utf8'});assert.notEqual(r.status,0,kind);
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
 }
});
