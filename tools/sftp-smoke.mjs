import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import ssh2 from "ssh2";
const { Server, utils } = ssh2;
const root=fs.mkdtempSync(path.join(os.tmpdir(),"termone-sftp-"));
const remote=path.join(root,"remote");fs.mkdirSync(remote);
for(const name of ["server-key","client-key"])execFileSync("ssh-keygen",["-q","-t","ed25519","-N","","-f",path.join(root,name)]);
let serial=0;
const attrs=stat=>({mode:stat.mode,uid:1000,gid:1000,size:stat.size,atime:Math.floor(stat.atimeMs/1000),mtime:Math.floor(stat.mtimeMs/1000)});
function resolve(p){const file=path.resolve(remote,String(p).replace(/^\/+/,""));if(file!==remote&&!file.startsWith(remote+path.sep))throw Error("outside fixture");return file;}
const clients=new Set();
const server=new Server({hostKeys:[fs.readFileSync(path.join(root,"server-key"))]},client=>{
 clients.add(client);client.on("close",()=>clients.delete(client));
 const handles=new Map();
 client.on("authentication",ctx=>ctx.username==="fixture"?ctx.accept():ctx.reject()).on("ready",()=>client.on("session",accept=>{
  const session=accept();session.on("sftp",accept=>{
   const s=accept();s.on("end",()=>s.end());const wrap=fn=>(id,...args)=>{try{fn(id,...args);}catch{s.status(id,2);}};
   s.on("REALPATH",wrap((id,p)=>s.name(id,[{filename:"/"+path.relative(remote,resolve(p||"/")),longname:"",attrs:{}}])));
   s.on("STAT",wrap((id,p)=>s.attrs(id,attrs(fs.statSync(resolve(p))))));s.on("LSTAT",wrap((id,p)=>s.attrs(id,attrs(fs.lstatSync(resolve(p))))));
   s.on("FSTAT",wrap((id,h)=>s.attrs(id,attrs(fs.fstatSync(handles.get(h.toString("hex")).fd)))));
   s.on("OPEN",wrap((id,p,flags)=>{const filename=resolve(p);const fd=fs.openSync(filename,utils.sftp.flagsToString(flags));const h=Buffer.alloc(4);h.writeUInt32BE(++serial);handles.set(h.toString("hex"),{fd,filename,bytes:0});s.handle(id,h);}));
   s.on("CLOSE",wrap((id,h)=>{const item=handles.get(h.toString("hex"));if(item?.fd!==undefined)fs.closeSync(item.fd);handles.delete(h.toString("hex"));s.status(id,0);}));
   s.on("READ",wrap((id,h,at,length)=>{const item=handles.get(h.toString("hex"));item.bytes+=length;const marker=path.join(root,"drop-download");if(fs.existsSync(marker)&&item.filename.endsWith("data.bin")&&item.bytes>8*1024*1024){fs.unlinkSync(marker);client.end();return;}const buffer=Buffer.alloc(Math.min(length,1024*1024));const n=fs.readSync(item.fd,buffer,0,buffer.length,at);n?s.data(id,buffer.subarray(0,n)):s.status(id,1);}));
   s.on("WRITE",wrap((id,h,at,data)=>{const item=handles.get(h.toString("hex"));item.bytes+=data.length;const marker=path.join(root,"drop-upload");if(fs.existsSync(marker)&&item.filename.includes("fail.bin")&&item.bytes>8*1024*1024){fs.unlinkSync(marker);client.end();return;}fs.writeSync(item.fd,data,0,data.length,at);s.status(id,0);}));
   s.on("OPENDIR",wrap((id,p)=>{const h=Buffer.alloc(4);h.writeUInt32BE(++serial);handles.set(h.toString("hex"),{directory:resolve(p),read:false});s.handle(id,h);}));
   s.on("READDIR",wrap((id,h)=>{const item=handles.get(h.toString("hex"));if(item.read){s.status(id,1);return;}item.read=true;const names=fs.readdirSync(item.directory).map(name=>{const stat=fs.statSync(path.join(item.directory,name));return {filename:name,longname:(stat.isDirectory()?"drwxr-xr-x":"-rw-r--r--")+" 1 fixture fixture "+stat.size+" Jan 1 12:00 "+name,attrs:attrs(stat)};});names.length?s.name(id,names):s.status(id,1);}));
   s.on("MKDIR",wrap((id,p)=>{fs.mkdirSync(resolve(p));s.status(id,0);}));s.on("RMDIR",wrap((id,p)=>{fs.rmdirSync(resolve(p));s.status(id,0);}));s.on("REMOVE",wrap((id,p)=>{fs.unlinkSync(resolve(p));s.status(id,0);}));
   s.on("SETSTAT",id=>s.status(id,0));s.on("FSETSTAT",id=>s.status(id,0));
   s.on("RENAME",wrap((id,a,b)=>{fs.renameSync(resolve(a),resolve(b));s.status(id,0);}));s.on("EXTENDED",id=>s.status(id,8));
  });
 })).on("error",()=>{}).on("close",()=>{for(const [key,item]of handles){if(item.fd!==undefined){try{fs.closeSync(item.fd);}catch{}}handles.delete(key);}});
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const bin=path.join(root,"bin");fs.mkdirSync(bin);const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
fs.writeFileSync(path.join(bin,"sftp"),"#!/bin/sh\nexec /usr/bin/sftp -F /dev/null -o IdentityAgent=none -o UserKnownHostsFile="+quote(path.join(root,"known_hosts"))+" \"$@\"\n",{mode:0o755});
try{
 const child=spawn(path.resolve("target/release/examples/sftp_smoke"),[String(server.address().port),root],{env:{...process.env,PATH:bin+path.delimiter+process.env.PATH},stdio:"inherit",detached:true});
 const timer=setTimeout(()=>process.kill(-child.pid,"SIGKILL"),120000);const code=await new Promise(resolve=>child.on("exit",resolve));clearTimeout(timer);if(code!==0)throw Error("SFTP smoke failed: "+code);
}finally{for(const client of clients)client.end();server.close();fs.rmSync(root,{recursive:true,force:true});}
