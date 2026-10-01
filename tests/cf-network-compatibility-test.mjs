import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyCfNetworkCompatibility, CF_NETWORK_COMPATIBILITY as contract, transformCfNetworkBundle } from "../src/local/cf-network-compatibility.mjs";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cfRoot = path.join(packageRoot, "node_modules", "cf");
const installed = readFileSync(path.join(cfRoot, contract.bundle), "utf8");
const originalFactory = "Ry=e(((e,t)=>{let n=pv(),r=G_(),i=gv(),a=_v(),o=vv(),s=yv(),c=Cv(),l=Sv(),u=wv(),d=Ev(),f=Dv(),p=q(),m=J(),{InvalidArgumentError:h}=p,g=Fv(),_=J_(),v=Bv(),{MockCallHistory:y,MockCallHistoryLog:b}=Vv(),x=Wv(),S=Hv(),C=qv(),w=Iv(),T=Tv(),{getGlobalDispatcher:E,setGlobalDispatcher:D}=Jv(),O=Yv(),k=Xv();Object.assign(r.prototype,g),t.exports.Dispatcher=r,t.exports.Client=n,t.exports.Pool=i,t.exports.BalancedPool=a,t.exports.RoundRobinPool=o,t.exports.Agent=s,t.exports.ProxyAgent=c,t.exports.Socks5ProxyAgent=l,t.exports.EnvHttpProxyAgent=u,t.exports.RetryAgent=d,t.exports.H2CClient=f,t.exports.RetryHandler=T,t.exports.DecoratorHandler=O,t.exports.RedirectHandler=k,t.exports.interceptors={redirect:Zv(),responseError:Qv(),retry:$v(),dump:ey(),dns:ty(),cache:sy(),decompress:cy(),deduplicate:uy()},t.exports.cacheStores={MemoryCacheStore:ay()};let A=dy();t.exports.cacheStores.SqliteCacheStore=A,t.exports.buildConnector=_,t.exports.errors=p,t.exports.util={parseHeaders:m.parseHeaders,headerNameToString:m.headerNameToString};function j(e){return(t,n,r)=>{if(typeof n==`function`&&(r=n,n=null),!t||typeof t!=`string`&&typeof t!=`object`&&!(t instanceof URL))throw new h(`invalid url`);if(n!=null&&typeof n!=`object`)throw new h(`invalid opts`);if(n&&n.path!=null){if(typeof n.path!=`string`)throw new h(`invalid opts.path`);let e=n.path;n.path.startsWith(`/`)||(e=`/${e}`),t=new URL(m.parseOrigin(t).origin+e)}else n||=typeof t==`object`?t:{},t=m.parseURL(t);let{agent:i,dispatcher:a=E()}=n;if(i)throw new h(`unsupported opts.agent. Did you mean opts.client?`);return e.call(a,{...n,origin:t.origin,path:t.search?`${t.pathname}${t.search}`:t.pathname,method:n.method||(n.body?`PUT`:`GET`)},r)}}t.exports.setGlobalDispatcher=D,t.exports.getGlobalDispatcher=E;let M=gy().fetch,N=typeof __filename<`u`?__filename:void 0;function P(e,t){if(!e||typeof e!=`object`)return;let n=typeof e.stack==`string`?e.stack:``,r=t.replace(/\\\\/g,`/`);if(n&&(n.includes(t)||n.includes(r)))return;let i={};if(Error.captureStackTrace(i,P),!i.stack)return;let a=i.stack.split(`\n`).slice(1).join(`\n`);e.stack=n?`${n}\\n${a}`:i.stack}t.exports.fetch=function(e,n=void 0){return M(e,n).catch(e=>{throw N?P(e,N):e&&typeof e==`object`&&Error.captureStackTrace(e,t.exports.fetch),e})},t.exports.Headers=fy().Headers,t.exports.Response=py().Response,t.exports.Request=my().Request,t.exports.FormData=sv().FormData;let{setGlobalOrigin:ee,getGlobalOrigin:te}=ev();t.exports.setGlobalOrigin=ee,t.exports.getGlobalOrigin=te;let{CacheStorage:ne}=yy(),{kConstruct:re}=L_();t.exports.caches=new ne(re);let{deleteCookie:ie,getCookies:ae,getSetCookies:oe,setCookie:se,parseCookie:F}=Cy();t.exports.deleteCookie=ie,t.exports.getCookies=ae,t.exports.getSetCookies=oe,t.exports.setCookie=se,t.exports.parseCookie=F;let{parseMIMEType:ce,serializeAMimeType:le}=rv();t.exports.parseMIMEType=ce,t.exports.serializeAMimeType=le;let{CloseEvent:ue,ErrorEvent:de,MessageEvent:fe}=wy(),{WebSocket:I,ping:L}=My();t.exports.WebSocket=I,t.exports.CloseEvent=ue,t.exports.ErrorEvent=de,t.exports.MessageEvent=fe,t.exports.ping=L,t.exports.WebSocketStream=Py().WebSocketStream,t.exports.WebSocketError=Ny().WebSocketError,t.exports.request=j(g.request),t.exports.stream=j(g.stream),t.exports.pipeline=j(g.pipeline),t.exports.connect=j(g.connect),t.exports.upgrade=j(g.upgrade),t.exports.MockClient=v,t.exports.MockCallHistory=y,t.exports.MockCallHistoryLog=b,t.exports.MockPool=S,t.exports.MockAgent=x,t.exports.SnapshotAgent=C,t.exports.mockErrors=w;let{EventSource:pe}=Ly();t.exports.EventSource=pe;function me(){globalThis.fetch=t.exports.fetch,globalThis.Headers=t.exports.Headers,globalThis.Response=t.exports.Response,globalThis.Request=t.exports.Request,globalThis.FormData=t.exports.FormData,globalThis.WebSocket=t.exports.WebSocket,globalThis.CloseEvent=t.exports.CloseEvent,globalThis.ErrorEvent=t.exports.ErrorEvent,globalThis.MessageEvent=t.exports.MessageEvent,globalThis.EventSource=t.exports.EventSource}t.exports.install=me}))";
const patchImport = 'import __mbmUndici from "undici";\n';
const original = hash(installed) === contract.originalSha256 ? installed
  : installed.replace(patchImport, "").replace("Ry=()=>__mbmUndici", originalFactory);
assert.equal(hash(original), contract.originalSha256, "upstream fixture reconstruction must match the actual pinned artifact");
const patched = transformCfNetworkBundle(original);
assert.equal(hash(patched), contract.patchedSha256);
assert.equal(transformCfNetworkBundle(Buffer.from(patched)), patched, "verified transformation must be idempotent");
assert.throws(() => transformCfNetworkBundle(original + "\n"), /pinned upstream or patched artifact/);
assert.throws(() => transformCfNetworkBundle(patched.replace("Ry=()=>__mbmUndici", "Ry=()=>null")), /pinned upstream or patched artifact/);
assert.throws(() => transformCfNetworkBundle(Buffer.alloc(2 * 1024 * 1024 + 1)), /byte limit/);
assert.throws(() => transformCfNetworkBundle({}), TypeError);

const root = mkdtempSync(path.join(tmpdir(), "mbm-cf-network-test-"));
try {
  const packageDirectory = path.join(root, "node_modules", "cf");
  const bundle = path.join(packageDirectory, contract.bundle);
  const manifest = path.join(packageDirectory, "package.json");
  mkdirSync(path.dirname(bundle), { recursive: true, mode: 0o700 });
  const reset = () => {
    rmSync(bundle, { force: true });
    writeFileSync(bundle, original, { mode: 0o600 });
    writeFileSync(manifest, JSON.stringify({ name: "cf", version: contract.version }), { mode: 0o600 });
  };
  reset();
  assert.equal(applyCfNetworkCompatibility(root).changed, true);
  assert.equal(readFileSync(bundle, "utf8"), patched);
  assert.equal(applyCfNetworkCompatibility(root).changed, false);
  writeFileSync(bundle, patched + "\n");
  assert.throws(() => applyCfNetworkCompatibility(root), /pinned upstream or patched artifact/);
  reset();
  writeFileSync(manifest, JSON.stringify({ name: "cf", version: "1.0.0-beta.999" }));
  assert.throws(() => applyCfNetworkCompatibility(root), /package version/);
  reset();
  const outside = path.join(root, "outside.mjs");
  writeFileSync(outside, original, { mode: 0o600 });
  rmSync(bundle);
  symlinkSync(outside, bundle);
  assert.throws(() => applyCfNetworkCompatibility(root), /private regular file/);
  rmSync(bundle);
  linkSync(outside, bundle);
  assert.throws(() => applyCfNetworkCompatibility(root), /private regular file/);
  reset();
  if (process.platform !== "win32") {
    chmodSync(bundle, 0o622);
    assert.throws(() => applyCfNetworkCompatibility(root), /private regular file/);
    chmodSync(bundle, 0o600);
  }
  rmSync(packageDirectory, { recursive: true });
  assert.deepEqual(applyCfNetworkCompatibility(root, { allowAbsent: true }), { present: false, changed: false });
  symlinkSync(cfRoot, packageDirectory, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => applyCfNetworkCompatibility(root), /real directory/);

  const before = await observeFactory(original);
  assert.equal(before.connectorPreserved, false, "the pinned upstream artifact must reproduce the regression");
  assert.equal(before.tlsVerifierPreserved, false);
  const after = await observeFactory(patched);
  assert.equal(after.connectorPreserved, true);
  assert.equal(after.tlsVerifierPreserved, true);
  assert.equal(after.externalFactory, true, "both public and private cf factory paths must use the pinned external library");
  assert.equal(before.requests + after.requests, 0, "construction must remain offline");
  console.log("cf network compatibility behavior, artifact, and tamper checks ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

async function observeFactory(source) {
  const observer = path.join(cfRoot, "dist", "mbm-cf-offline-" + randomUUID() + ".mjs");
  writeFileSync(observer, source + "\nexport { Ry as mbmObservedFactory };\n", { flag: "wx", mode: 0o600 });
  try {
    const observed = await import(pathToFileURL(observer).href);
    const external = (await import("undici")).default;
    const library = observed.mbmObservedFactory();
    let requests = 0;
    const connect = () => { requests += 1; throw new Error("Offline construction initiated a connection"); };
    const checkServerIdentity = () => new Error("Offline TLS sentinel");
    let captured;
    const pool = new library.BalancedPool("https://example.invalid", {
      connect, tls: { checkServerIdentity },
      factory(origin, options) { captured = options; return new library.Pool(origin, options); },
    });
    try {
      return {
        connectorPreserved: captured.connect === connect,
        tlsVerifierPreserved: captured.tls?.checkServerIdentity === checkServerIdentity,
        externalFactory: library === external && observed.B() === external,
        requests,
      };
    } finally { await pool.close(); }
  } finally { rmSync(observer, { force: true }); }
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
