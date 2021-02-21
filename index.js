/*<--server_only*/
var fs = require('fs'),
	dns = require('dns'),
	zlib = require('zlib'),
	util = require('util'),
	path = require('path'),
	http = require('http'),
	https = require('https'),
	ws = require('./ws.js'),
	jsdom = require('./jsdom.js').JSDOM,
	terser = require('./terser.js'),
	adblock = require('./adblock.js'),
	filter_data = {},
	adblock_match = input => filter_data.filters.find(filter => {
		// adblock.matchesFilter(filter, input);
		if(filter.isRegex)return (filter.regex || (filter.regex = new RegExp(filter.data))).test(input.href);
		
		if(filter.leftAnchored && filter.rightAnchored)return filter.data == input.href;
		
		if(filter.rightAnchored)return input.href.slice(-filter.data.length) == filter.data;
		
		if(filter.leftAnchored)return input.href.substring(0, filter.data.length) == filter.data;
		
		var parts = filter.data.split('*'), index = 0;
		
		if(filter.data.match(/^[0-9a-z]/i) && input.hostname.endsWith(filter.data.split(' ').splice(-1)[0]))return true;
		
		return false;
	});

adblock.parse(fs.readFileSync(path.join(__dirname, 'adblock.txt'), 'utf8'), filter_data);

function indexOfFilter(input, filter, startingPos) {
	if (filter.length > input.href.length) {
		return -1;
	}

	var filterParts = filter.split('^');
	var index = startingPos;
	var beginIndex = -1;
	var prefixedSeparatorChar = false;

	for (var f = 0; f < filterParts.length; f++) {
		if (filterParts[f] === '') {
			prefixedSeparatorChar = true;
			continue;
		}

		index = input.href.indexOf(filterParts[f], index);
		
		if(index == -1)return -1;
		
		if(beginIndex == -1)beginIndex = index;
		
		if (prefixedSeparatorChar) {
			if (':?/=^'.indexOf(input.href[index - 1]) === -1) {
				return -1;
			}
		}
		// If we are in an in between filterPart
		if (f + 1 < filterParts.length &&
			// and we have some chars left in the input past the last filter match
			input.href.length > index + filterParts[f].length) {
			if(':?/=^'.indexOf(input.href[index + filterParts[f].length]) == -1)return -1;
		}

		prefixedSeparatorChar = false;
	}
	
	return beginIndex;
}
/*server_only-->*/

var URL = require('./url.js');

module.exports = class {
	constructor(config){
		this.config = Object.assign({
			adblock: true,
			ruffle: false,
			http_agent: module.browser ? null : new http.Agent({}),
			https_agent: module.browser ? null : new https.Agent({ rejectUnauthorized: false }),
			codec: module.exports.codec.plain,
			interface: null,
			prefix: null,
			ws: true, // websocket proxying
			timeout: 30000, // max request timeout
			title: 'Service',
		}, config);
		
		this.URL = class extends URL {
			get fullpath(){
				return this.href.substr(this.origin.length);
			}
		};
		
		if(typeof this.config.codec == 'string')this.config.codec = module.exports.codec[this.config.codec];
		
		/*<--server_only*/if(this.config.server){
			if(this.config.dns)dns.setServers(this.config.dns);
			
			this.config.server_ssl = this.config.server.ssl;
			
			this.config.server.use(this.config.prefix + '*', (req, res) => {
				if(req.url.searchParams.has('ruffle'))return res.static(path.join(__dirname, 'ruffle.wasm'));
				if(req.url.searchParams.has('html'))return res.contentType('application/javascript').send(this.preload[0] || '');
				if(req.url.searchParams.has('favicon'))return res.contentType('image/png').send(Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAA', 'base64'));
				
				var url = this.valid_url(this.unurl(req.url)),
					data = { origin: req.url, url: url, base: url },
					failure = false,
					timeout = setTimeout(() => !res.resp.sent_body && (failure = true, res.cgi_status(500, 'Timeout')), this.config.timeout);
				
				if(!url || !this.http_protocols.includes(url.protocol))return res.redirect('/');
				
				if(this.config.adblock){
					var matched = adblock_match(url);
					
					if(matched)return res.cgi_status(401, JSON.stringify(matched), 'Adblock active');
				}
				
				dns.lookup(url.hostname, (err, ip) => {
					if(err)return res.cgi_status(400, err);
					
					if(ip.match(this.regex.url.ip))return console.log(url.href) + res.cgi_status(403, 'Forbidden IP');
					
					try{
						(url.protocol == 'http:' ? http : https).request({
							agent: url.protocol == 'http:' ? this.config.http_agent : this.config.https_agent,
							servername: url.hostname,
							hostname: ip,
							path: url.fullpath,
							port: url.port,
							protocol: url.protocol,
							localAddress: this.config.interface,
							headers: this.headers_encode(req.headers, data),
							method: req.method,
						}, resp => this.decompress(req, resp, body => {
							var dest = req.headers['sec-fetch-dest'],
								decoded = this.decode_params(req.url),
								content_type = (resp.headers['content-type'] || '').split(';')[0],
								type =  content_type == 'text/plain' ? 'plain' : dest == 'font' ? 'font' : decoded.has('type') ? decoded.get('type') : dest == 'script' ? 'js' : (this.mime_ent.find(([ key, val ]) => val.includes(content_type)) || [])[0],
								dec_headers = this.headers_decode(resp.headers, data);
							
							res.status(resp.statusCode.toString().startsWith('50') ? 400 : resp.statusCode);
							
							for(var name in dec_headers)res.set(name, dec_headers[name]);
							
							clearTimeout(timeout);
							
							if(failure)return;
							
							var body = decoded.get('route') != 'false' && ['js', 'css', 'html', 'plain', 'manifest'].includes(type) ? this[type](body, data) : body;
							
							res.compress('br', body);
						})).on('error', err => {
							clearTimeout(timeout);
							
							if(failure || res.resp.sent_body)return;
							
							res.cgi_status(400, err);
						}).end(req.raw_body);
					}catch(err){
						clearTimeout(timeout);
						
						if(failure || res.resp.sent_body)return;
						
						console.error('runtime error:', err);
						
						res.cgi_status(400, err);
					}
				});
			});
			
			if(this.config.ws){
				var wss = new ws.Server({ server: this.config.server.server });
				
				wss.on('connection', (cli, req) => {
					var req_url = new this.URL(req.url, new URL('wss://' + req.headers.host)),
						url = this.valid_url(this.unurl(req_url));
					
					if(!url)return cli.close();
					
					var headers = this.headers_encode(req.headers, { url: url, origin: req_url, base: url }),
						srv = new ws(url, {
							headers: headers,
							agent: ['wss:', 'https:'].includes(url.protocol) ? this.config.https_agent : this.config.http_agent,
						}),
						time = 8000,
						timeout = setTimeout(() => srv.close(), time),
						interval = setInterval(() => cli.send('srv-alive'), time / 2),
						queue = [];
					
					srv.on('error', err => console.error(headers, url.href, util.format(err)) + cli.close());
					
					cli.on('message', data => (clearTimeout(timeout), timeout = setTimeout(() => srv.close(), time), data != 'srv-alive' && (srv.readyState && srv.send(data) || queue.push(data))));
					
					srv.on('open', () => {
						cli.send('srv-open');
						
						queue.forEach(data => srv.send(data));
						
						srv.on('error', code => cli.close());
						
						srv.on('message', data => cli.send(data));
						
						srv.on('close', code => cli.close());
						
						cli.on('close', code => srv.close() + clearTimeout(timeout) + clearInterval(interval));
					});
				});
			}
		}/*server_only-->*/
		
		this.dom = module.browser ? global : new jsdom();
		
		if(this.dom.window && this.dom.window.DOMParser)this.html_parser = new this.dom.window.DOMParser();
		
		this.regex = {
			js: {
				comment: /\/{2}/g,
				prw_ind: /\/\*(pmrw\d+)\*\/[\s\S]*?\/\*\1\*\//g,
				prw_ins: /\/\*pmrwins(\d+)\*\//g,
				window_assignment: /(?<![a-z])window(?![a-z])\s*?=(?!=)this/gi,
				call_this: /(\?\s*?)this(\s*?:)|()()(?<![a-zA-Z_\d'"$])this(?![:a-zA-Z_\d'"$])/g,
				construct_this: /new rw_this\(this\)/g,
				// hooking function is more practical but cant do
				eval: /(?<![a-zA-Z0-9_$.,])(?:window\.|this)?eval(?![a-zA-Z0-9_$])/g,
				// import_exp: /(?<!['"])(import\s+[{"'`*](?!\*)[\s\S]*?from\s*?(["']))([\s\S]*?)(\2;)/g,
				// work on getting import() function through
				// (match, start, quote, url, end) 
				// export_exp: /export\s*?\{[\s\S]*?;/g,
				server_only: /\/\*<--server_only\*\/[\s\S]*?\/\*server_only-->\*\//g,
				sourceurl: /#\s*?sourceURL/gi,
			},
			css: {
				url: /(?<![a-z])(url\s*?\(("|'|))([\s\S]*?)\2\)/gi,
				import: /(@import\s*?(\(|"|'))([\s\S]*?)(\2|\))/gi,
				property: /(\[)(\w+)(\*?=.*?]|])/g,
			},
			html: {
				srcset: /(\S+)(\s+\d\S)/g,
				newline: /\n/g,
			},
			url: {
				proto: /^([^\/]+:)/,
				host: /(:\/+)_(.*?)_/,
				ip: /^192\.168\.|^172\.16\.|^10\.0\.|^127\.0/,
				whitespace: /\s+/g,
			},
			skip_header: /(?:^sec-websocket-key|^cdn-loop|^cf-(request|connect|ip|visitor|ray)|^real|^forwarded-|^x-(real|forwarded|frame)|^strict-transport|content-(security|encoding|length)|transfer-encoding|access-control|sourcemap|trailer)/i,
			sourcemap: /#\s*?sourceMappingURL/gi,
		};
		
		this.mime = {
			js: [ 'text/javascript', 'text/emcascript', 'text/x-javascript', 'text/x-emcascript', 'application/javascript', 'application/x-javascript', 'application/emcascript', 'application/x-emcascript' ],
			css: [ 'text/css' ],
			html: [ 'text/html' ],
			xml: [ 'application/xml', 'application/xhtml+xml', 'application/xhtml+xml' ],
		};

		this.mime_ent = Object.entries(this.mime);

		this.attr = {
			html: [ [ 'iframe' ], [ 'srcdoc' ] ],
			css: [ '*', [ 'style' ] ],
			url: [ [ 'track', 'template', 'source', 'script', 'object', 'media', 'link', 'input', 'image', 'video', 'iframe', 'frame', 'form', 'embed', 'base', 'area', 'anchor', 'a', 'img', 'use' ], [ 'srcset', 'href', 'xlink:href', 'src', 'action', 'content', 'data', 'poster' ] ],
			// js attrs begin with on
			del: [ '*', ['nonce', 'integrity'] ],
		};
		
		this.attr_ent = Object.entries(this.attr);
		
		this.protocols = [ 'http:', 'https:', 'ws:', 'wss:' ];
		
		this.http_protocols = [ 'http:', 'https:' ];
		
		/*<--server_only*/if(!module.browser){
			this._bundler = class {
				constructor(modules, wrapper = [ '', '' ]){
					this.modules = modules;
					this.path = globalThis.fetch ? null : require('path');
					this.wrapper = wrapper;
					this._after = {};
				}
				after(mod, cb){
					(this._after[mod] || (this._after[mod] = [])).push(cb);
				}
				wrap(str){
					return JSON.stringify([ str ]).slice(1, -1);
				}
				resolve_contents(path){
					return new Promise((resolve, reject) => globalThis.fetch ? fetch(path).then(res => res.text()).then(resolve).catch(reject) : fs.promises.readFile(path, 'utf8').then(resolve).catch(reject));
				}
				relative_path(path){
					return this.path ? this.path.relative(__dirname, path) : path;
				}
				run(){
					return new Promise((resolve, reject) => Promise.all(this.modules.map(data => new Promise((resolve, reject) => this.resolve_contents(data).then((text, str = (data.endsWith('.json') ? 'module.exports=' + JSON.stringify(JSON.parse(text)) : text)) => resolve(this.wrap(new URL(this.relative_path(data), 'http:a').pathname) + '(module,exports,require,global){' + (this._after[data] && this._after[data].forEach(cb => str = cb(str)), str) + '}')).catch(err => reject('Cannot locate module ' + data + '\n' + err))))).then(mods => resolve(this.wrapper[0] + 'var require=((l,i,h)=>(h="http:a",i=e=>(n,f,u)=>{f=l[typeof URL=="undefined"?n.replace(/\\.\\//,"/"):new URL(n,e).pathname];if(!f)throw new TypeError("Cannot find module \'"+n+"\'");!f.e&&f.apply((f.e={}),[{browser:!0,get exports(){return f.e},set exports(v){return f.e=v}},f.e,i(h+f.name),new(_=>_).constructor("return this")()]);return f.e},i(h)))({' + mods.join(',') + '});' + this.wrapper[1] )).catch(reject));
				}
			};
			
			var modules = [
				path.join(__dirname, 'html.js'),
				path.join(__dirname, 'url.js'),
				__filename,
			];
			
			if(this.config.ruffle)modules.push(path.join(__dirname, 'ruffle.js'));
			
			var bundler = new this._bundler(modules);
			
			bundler.after(path.join(__dirname, 'ruffle.js'), data => {
				return '(fetch=>{' + data.replace(this.regex.sourcemap, '# undefined') + ')((url, opts) => console.log(url, opts))';
			});
			
			this.preload = ['alert("preload.js not ready!");', 0];
			
			this.bundle = async () => {
				var times = await Promise.all(bundler.modules.map(data => new Promise(resolve => fs.promises.stat(data).then(data => resolve(data.mtimeMs))))).then(data => data.join(''));
				
				if(this.preload[1] == times)return;
				
				var ran = await bundler.run().then(code => code.replace(this.regex.js.server_only, '')),
					merged = 'document.currentScript&&document.currentScript.remove();window.__pm_init__=rewrite_conf=>{' + ran + 'require("./html.js")};window.__pm_init__(' + this.str_conf() + ')';
				
				this.preload = [ await terser.minify(merged, {
					compress: {
						toplevel: true,
						drop_debugger: false,
					},
				}).then(data => data.code + '\n//# sourceURL=RW-HTML').catch(console.error), times ];
			};
			
			new this._bundler([
				path.join(__dirname, 'url.js'),
				__filename,
			]).run().then(code => terser.minify(code.replace(this.regex.js.server_only, ''))).then(data => {
				this.prw = data.code + 'return require("./index.js")';
			});
			
			terser.minify('function ' + this.globals).then(data => this.glm = this.config.glm = data.code);
			
			this.bundle();
			setInterval(this.bundle, 2000);
		}else/*server_only-->*/{
			this.prw = this.config.prw
			this.glm = this.config.glm;
			this.preload = [ 'alert("how!")', Date.now() ];
		}
	}
	decode_params(url){
		url = url + '';
		
		var start = url.indexOf(this.config.prefix) + this.config.prefix.length,
			search_ind = url.indexOf('?'),
			out
		
		try{
			out = new this.URL.searchParams(decodeURIComponent(url.substr(start, search_ind == -1 ? url.length : search_ind)));
		}catch(err){
			out = new this.URL.searchParams();
		}
		
		if(search_ind != -1)out.osearch = url.substr(search_ind);
		
		return out;
	}
	decompress(req, res, callback){
		var chunks = [];
		
		if(req.method != 'HEAD' && res.statusCode != 204  && res.statusCode != 304)switch(res.headers['content-encoding'] || res.headers['x-content-encoding']){
			case'gzip':
				res = res.pipe(zlib.createGunzip({
					flush: zlib.Z_SYNC_FLUSH,
					finishFlush: zlib.Z_SYNC_FLUSH
				}));
				
				break;
			case'deflate':
				return res.once('data', chunk =>
					res.pipe((chunk[0] & 0x0F) === 0x08 ? zlib.createInflate() : zlib.createInflateRaw()).on('data', chunk => chunks.push(chunk)).on('end', () => callback(Buffer.concat(chunks)))
				);
				
				break;
			case'br':
				res = res.pipe(zlib.createBrotliDecompress({
					flush: zlib.Z_SYNC_FLUSH,
					finishFlush: zlib.Z_SYNC_FLUSH
				}));
				
				break;
		}
		
		res.on('data', chunk => chunks.push(chunk)).on('end', () => callback(Buffer.concat(chunks))).on('error', err => console.error(err) + callback(Buffer.concat(chunks)));
	}
	valid_url(...args){
		var out;
		
		try{ out = new this.URL(...args) }catch(err){}
		
		return out;
	}
	str_conf(){
		return JSON.stringify({
			codec: this.config.codec.name,
			prefix: this.config.prefix,
			title: this.config.title,
			server_ssl: !!this.config.server_ssl,
			adblock: this.config.adblock,
			ruffle: this.config.ruffle,
			ws: this.config.ws,
			// preload-rewriting
			prw: this.prw,
			// global-rewriting
			glm: this.glm,
		});
	}
	globals(url, rw){
		var global = new (_=>_).constructor('return this')(),
			URL = rw.URL,
			_proxy = function(target, desc){if(typeof target == 'function')return Object.defineProperties(function(...args){return new.target?desc.construct?desc.construct(target,args):new target(...args):desc.apply?desc.apply(target,this,args):target(...args)},Object.getOwnPropertyDescriptors(target));var n=[],i = o =>{var proto = Object.getPrototypeOf(o);if(typeof o!='object'||!proto)return o;n.push(...Object.getOwnPropertyNames(o));i(proto);return o};i(target);return Object.defineProperties({},Object.fromEntries(n.map(p=>[p,{get:_=>desc.ge?desc.get(target,p):Reflect.get(target,p),set:v=>desc.set?desc.set(target,p,v):Reflect.set(target,p,v)}])))},
			_pm_ = global._pm_ || (global._pm_ = { backups: {}, blob_store: new Map(), url_store: new Map(), url: new URL(url), proxied: 'pm.proxied', original: 'pm.original' }),
			Reflect = Object.fromEntries(Object.getOwnPropertyNames(global.Reflect).map(key => [ key, global.Reflect[key] ])),
			def = {
				rw_data: data => Object.assign({ url: fills.url, base: fills.url, origin: def.loc }, data ? data : {}),
				handler: (tg, prox_targ) => (Object.defineProperties(prox_targ, Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(tg)).map(([ key, val ]) => (val.hasOwnProperty('configurable') && (val.configurable = true), [ key, val ])))), {
					set: (t, prop, value) => Reflect.set(tg, prop, value),
					has: (t, ...a) => Reflect.has(tg, ...a),
					ownKeys: (t, ...a) => Reflect.ownKeys(tg, ...a),
					enumerate: (t, ...a) => Reflect.enumerate(tg, ...a),
					getOwnPropertyDescriptor: (t, p) => Reflect.getOwnPropertyDescriptor(prox_targ, p),
					defineProperty: (t, prop, desc) => {
						
						Reflect.defineProperty(prox_targ, prop, desc);
						
						return Reflect.defineProperty(tg, prop, desc);
					},
					deleteProperty: (t, ...a) => Reflect.deleteProperty(tg, ...a),
					getPrototypeOf: t => Reflect.getPrototypeOf(tg),
					setPrototypeOf: (t, ...a) => Reflect.setPrototypeOf(tg, ...a),
					isExtensible: t => Reflect.isExtensible(tg),
					preventExtensions: t => Reflect.preventExtensions(tg),
				}),
				bind: (a, b) => Reflect.apply(def.restore(Function.prototype.bind)[0], a, [ b ]),
				is_native: func => typeof func == 'function' && Reflect.apply(def.$backup(() => Function.prototype.toString), func, []) == 'function ' + func.name + '() { [native code] }',
				storage_handler: {
					get: (target, prop, receiver, ret) => prop == _pm_.original ? target : prop == _pm_.proxied ? receiver : (typeof (ret = Reflect.get(target, prop)) == 'function' ? def.bind(ret, target) : target.getItem(prop)),
					set: (target, prop, value) => (target.setItem(prop, value), true),
				},
				backup: {},
				$backup: (func, val) => (val = func(), val[_pm_.original] || _pm_.backups[func.toString()] || (_pm_.backups[func.toString()] = val)),
				$prop: (obj, prop, orig) => (Object.defineProperty(obj, prop, { value: orig, enumerable: false, writable: true }), orig),
				has_prop: (obj, prop) => prop && obj && Reflect.apply(def.restore(Object.prototype.hasOwnProperty)[0], obj, [ prop ]),
				alt_prop: (obj, prop) => def.has_prop(obj, prop) ? obj[prop] : null,
				assign_func: (func, bind) => func[_pm_.proxied] || def.$prop(def.$prop(func, _pm_.original, func), _pm_.proxied, Object.defineProperties(def.bind(def.is_native(func) ? new _proxy(func, { construct: (target, args) => Reflect.construct(target, def.restore(...args)), apply: (target, that, args) => Reflect.apply(target, that, def.restore(...args)) }) : func, bind), Object.getOwnPropertyDescriptors(func))),
				proxy_targets: {
					/* blank class to remove all native object methods */
					win: Object.setPrototypeOf({}, null),
					doc: Object.setPrototypeOf({}, null),
					url: Object.setPrototypeOf({}, null),
				},
				defineprop_handler: {
					apply(target, that, [ obj, prop, desc ]){
						if(obj && obj[_pm_.original])desc[def.has_prop(desc, 'value') ? 'writable' : 'configurable'] = true;
						
						return Reflect.apply(target, that, [ obj, prop, desc ]);
					},
				},
				// VERY annoying how natives get overwritten then screwed with
				restore: (...args) => Reflect.apply(def.$backup(() => Array.prototype.map), args, [ arg => arg ? arg[_pm_.original] || arg : arg ]),
				proxify: (...args) => Reflect.apply(def.$backup(() => Array.prototype.map), args, [ arg => arg ? arg[_pm_.proxied] || arg : arg ]),
				prefix: {
					origin: prop => prop.split('@').splice(-1).join(''),
					name: prop => (typeof prop != 'string' ? 'prop' : prop) + '@' + new URL(rw.unurl(def.get_href(), { origin: def.loc })).hostname,
					unname: (prop = '', split) => (split = prop.split('@'), split.splice(-1), split.join('')),
				},
				get_href(){ // return URL object of parent or current url
					var x = def.loc ? def.loc.href : null;
					
					if(!x || !x.hostname)try{ x = global.parent.location.href }catch(err){}
					
					try{ x = new URL(x) }catch(err){};
					
					return x;
				},
				url_binds: {
					replace(url){
						return def.loc.replace(rw.url(url, { base: fills.url, origin: def.loc }));
					},
					assign(url){
						return def.loc.assign(rw.url(url, { base: fills.url, origin: def.loc }));
					},
					reload(){
						def.loc.reload();
					},
				},
				win_binds: {
					// called without scope only with window.eval, not literal eval
					eval: new _proxy(global.eval, {
						apply: (target, that, [ script ]) => Reflect.apply(target, that, [ global.pm_eval(script) ]),
					}),
					constructor: global.Window,
					Window: global.Window,
					get location(){
						return fills.url;
					},
					set location(value){
						return fills.url.href = value;
					},
					get origin(){
						return fills.url.origin;
					},
				},
				doc_binds: {
					get URL(){
						return fills.url.href;
					},
					get referrer(){
						var ret = def.doc.referrer;
						
						return ret ? new URL(rw.unurl(ret, def.loc, fills.url, { origin: def.loc })||{href:''}).href : fills.url.href;
					},
					get location(){
						return fills.url;
					},
					set location(value){
						return fills.url.href = value;
					},
					get domain(){
						return fills.url.hostname;
					},
				},
			};
		
		// backup CRITICAL props
		def.$backup(() => Function.prototype.toString, Function.prototype.toString);
		def.$backup(() => Function.prototype.bind, Function.prototype.bind);
		def.$backup(() => Object.prototype.hasOwnProperty, Object.prototype.hasOwnProperty);
		def.$backup(() => Array.prototype.map, Array.prototype.map);
		
		def.loc = def.restore(global.location)[0];
		def.doc = def.restore(global.document)[0];
		
		/* to avoid did not return original value, set proxy target to {} */
		
		var fills = _pm_.fills = {
			this: new Proxy(global, Object.assign(def.handler(global, def.proxy_targets.win), {
				get: (t, prop, rec, ret) => prop == _pm_.proxied ? fills.this : prop == _pm_.original ? global : typeof (ret = Reflect.get(def.has_prop(def.win_binds, prop) ? def.win_binds : global, prop)) == 'function' ? def.assign_func(ret, global) : ret && ret[_pm_.proxied] || ret,
				set: (t, prop, value) => def.has_prop(def.win_binds, prop) ? (def.win_binds[prop] = value) : Reflect.set(global, prop, value),
			})),
			doc: def.doc ? new Proxy(def.proxy_targets.doc, Object.assign(def.handler(def.doc, def.proxy_targets.doc), {
				get: (t, prop, rec, ret) => prop == _pm_.proxied ? fills.doc : prop == _pm_.original ? def.doc : def.has_prop(def.doc_binds, prop) ? def.doc_binds[prop] : (typeof (ret = Reflect.get(def.doc, prop))) == 'function'
					? def.assign_func(ret, def.doc) : ret,
				set: (t, prop, value) => Object.getOwnPropertyDescriptor(def.doc_binds, prop) ? (def.doc_binds[prop] = value) : Reflect.set(def.doc, prop, value),
			})) : undefined,
			_url: def.loc ? new URL(rw.unurl(def.loc, { origin: def.loc })) : undefined,
			url: def.loc ? new Proxy(def.proxy_targets.url, Object.assign(def.handler(def.loc, def.proxy_targets.url), {
				get: (target, prop, ret) => prop == _pm_.proxied ? fills.url : prop == _pm_.original ? def.loc : def.alt_prop(def.url_binds, prop) || (fills._url.href = rw.unurl(def.loc, { origin: def.loc }), typeof (ret = fills._url[prop]) == 'function' ? def.bind(ret, fills._url) : ret),
				set: (target, prop, value) => {
					fills._url.href = rw.unurl(def.loc, { origin: def.loc });
					
					/* cant change much */
					if(fills._url.protocol == 'blob:')return true;
					
					var ohref = fills._url.href;
					
					fills._url[prop] = value;
					
					if(fills._url.href != ohref)def.loc.href = rw.url(fills._url.href, { url: rw.unurl(def.loc, { origin: def.loc }), origin: def.loc });
					
					return true;
				},
			})) : undefined,
		};
		
		def.$prop(global, _pm_.proxied, fills.this);
		if(def.doc)def.$prop(def.doc, _pm_.proxied, fills.doc);
		
		global.rw_this = that => def.proxify(that)[0];
		// get scope => eval inside of scope
		global.pm_eval = js => '(()=>' + rw.js('return eval(' + rw.wrap(rw.js(js, { url: fills.url, origin: def.loc, base: fills.url, scope: false })) + ')', def.rw_data({ rewrite: false })) + ')()';
		
		[
			[ x => x ? (global.Function = x) : global.Function, value => new _proxy(value, {
				construct(target, args){
					var ref = Reflect.construct(target, args);
					
					return Object.assign(Object.defineProperties(Reflect.construct(target, [ ...args.slice(0, -1), 'return(()=>' + rw.js(args.slice(-1)[0], { url: fills.url, origin: def.loc, base: fills.url, global: true }) + ')()' ]), Object.getOwnPropertyDescriptors(ref)), { toString: def.bind(ref.toString, ref) });
				},
				apply(target, that, args){
					var params = args.slice(0, -1),
						script = args.slice(-1)[0];
					
					return Reflect.apply(target, that, [ ...params, 'return(()=>' + rw.js(script , _pm_) + ')()' ])
				},
			}) ],
			[ x => x ? (global.Function.prototype.bind = x) : global.Function.prototype.bind, value => new _proxy(value, {
				apply: (target, that, args) => Reflect.apply(target, that, def.is_native(that) ? def.restore(...args) : args),
			}) ],
			[ x => x ? (global.Function.prototype.apply = x) : global.Function.prototype.apply, value => new _proxy(value, {
				apply: (target, that, args) => Reflect.apply(target, that, def.is_native(that) ? def.restore(...args) : args),
			}) ],
			[ x => x ? (global.Function.prototype.call = x) : global.Function.prototype.call, value => new _proxy(value, {
				apply: (target, that, args) => Reflect.apply(target, that || {}, def.is_native(that) ? def.restore(...args) : args),
			}) ],
			[ x => x ? (global.fetch = x) : global.fetch, value => new _proxy(value, {
				apply: (target, that, [ url, opts ]) => Reflect.apply(target, global, [ rw.url(url, { base: fills.url, origin: def.loc, route: false }), opts ]),
			}) ],
			[ x => x ? (global.Blob = x) : global.Blob, value => new _proxy(value, {
				construct(target, [ data, opts ]){
					var decoded = opts && rw.mime.js.includes(opts.type) && Array.isArray(data) ? [ rw.js(rw.decode_blob(data), { url: fills.url, origin: def.loc }) ] : data,
						blob = Reflect.construct(target, [ decoded, opts ]);
					
					_pm_.blob_store.set(blob, decoded[0]);
					
					return blob;
				},
			}) ],
			[ x => x ? (global.Document.prototype.write = x) : global.Document.prototype.write, value => new _proxy(value, {
				apply: (target, that, args) => Reflect.apply(target, that, [ rw.html(args.join(''), def.rw_data({ snippet: true })) ]),
			}) ],
			[ x => x ? (global.Document.prototype.writeln = x) : global.Document.prototype.writeln, value => new _proxy(value, {
				apply: (target, that, args) => Reflect.apply(target, that, [ rw.html(args.join(''), def.rw_data({ snippet: true })) ]),
			}) ],
			[ x => x ? (global.WebSocket = x) : global.WebSocket, value => class extends value {
				constructor(url, proto){
					super(rw.url(url, def.rw_data({ ws: true })), proto);
					
					this.addEventListener('message', event => event.data == 'srv-alive' && event.stopImmediatePropagation() + this.send('srv-alive') || event.data == 'srv-open' && event.stopImmediatePropagation() + this.dispatchEvent(new Event('open', { srcElement: this, target: this })));
					
					this.addEventListener('open', event => event.stopImmediatePropagation(), { once: true });
				}
			} ],
			[ x => x ? (global.URL.createObjectURL = x) : global.URL.createObjectURL, value => new _proxy(value, {
				apply(target, that, [ source ]){
					var url = Reflect.apply(target, that, [ source ]);
					
					_pm_.url_store.set(url, _pm_.blob_store.get(source));
					
					return url;
				},
			}) ],
			[ x => x ? (global.URL.revokeObjectURL = x) : global.URL.revokeObjectURL, value => new _proxy(value, {
				apply(target, that, [ url ]){
					var ret = Reflect.apply(target, that, [ url ]);
					
					_pm_.url_store.delete(url);
					
					return ret;
				},
			}) ],
			[ x => x ? (global.Object.defineProperty = x) : global.Object.defineProperty, value => new _proxy(value, def.defineprop_handler) ],
			[ x => x ? (global.Reflect.defineProperty = x) : global.Reflect.defineProperty, value => new _proxy(value, def.defineprop_handler) ],
			[ x => x ? (global.History.prototype.pushState = x) : global.History.prototype.pushState, value => new _proxy(value, {
				apply: (target, that, [ state, title, url ]) => Reflect.apply(target, that, [ state, title, rw.url(url, { origin: def.loc, base: fills.url }) ]),
			}) ],
			[ x => x ? (global.History.prototype.replaceState = x) : global.History.prototype.replaceState, value => new _proxy(value, {
				apply: (target, that, [ state, title, url ]) => Reflect.apply(target, that, [ state, title, rw.url(url, { origin: def.loc, base: fills.url }) ]),
			}) ],
			[ x => x ? (global.IDBFactory.prototype.open = x) : IDBFactory.prototype.open, value => new _proxy(value, {
				apply: (target, that, [ name, version ]) => Reflect.apply(target, that, [ def.prefix.name(name), version ]),
			}) ],
			[ x => x ? (global.localStorage = x) : global.localStorage, value => (delete global.localStorage, new Proxy(value, def.storage_handler)) ],
			[ x => x ? (global.sessionStorage = x) : global.sessionStorage, value => (delete global.sessionStorage, new Proxy(value, def.storage_handler)) ],
			[ x => x ? (global.Storage.prototype.getItem = x) : global.Storage.prototype.getItem, value => new _proxy(value, {
				apply: (target, that, [ prop ]) => Reflect.apply(target, that, [ def.prefix.name(prop) ]),
			}) ],
			[ x => x ? (global.Storage.prototype.setItem = x) : global.Storage.prototype.setItem, value => new _proxy(value, {
				apply: (target, that, [ prop, value ]) => Reflect.apply(target, that, [ def.prefix.name(prop), value ]),
			}) ],
			[ x => x ? (global.Storage.prototype.removeItem = x) : global.Storage.prototype.removeItem, value => new _proxy(value, {
				apply: (target, that, [ prop, ]) => Reflect.apply(target, that, [ def.prefix.name(prop) ]),
			}) ],
			[ x => x ? (global.Storage.prototype.clear = x) : global.Storage.prototype.clear, value => new _proxy(value, {
				apply: (target, that) => Object.keys(that).forEach(val => def.prefix.origin(val) == fills.url.hostname && that.removeItem(prop))
			}) ],
			[ x => x ? (global.Storage.prototype.key = x) : global.Storage.prototype.key, value => new _proxy(value, {
				apply: (target, that, [ key ]) => def.prefix.unname(Reflect.apply(target, that, [ key ])),
			}) ],
			[ x => x ? (global.importScripts = x) : global.importScripts, value => new _proxy(value, {
				apply: (target, that, args) => Reflect.apply(target, that, args.map(url => rw.url(url, def.rw_data({ type: 'js' })))),
			}) ],
			[ x => x ? (global.XMLHttpRequest.prototype.open  = x) : global.XMLHttpRequest.prototype.open, value => new _proxy(value, {
				apply: (target, that, [ method, url, ...args ]) => Reflect.apply(target, that, [ method, rw.url(url, def.rw_data({ route: false })), ...args ]),
			}) ],
			[ x => x ? (global.Navigator.prototype.sendBeacon = x) : global.Navigator.prototype.sendBeacon, value => new _proxy(value, {
				apply: (target, that, [ url, data ]) => Reflect.apply(target, that, [ rw.url(url, def.rw_data()), data ]),
			}) ],
			[ x => x ? (global.open = x) : global.open, value => new _proxy(value, {
				apply: (target, that, [ url, name, features ]) => Reflect.apply(target, that, [ rw.url(url, def.rw_data()), name, features ]),
			}) ],
			[ x => x ? (global.Worker = x) : global.Worker, value => new _proxy(value, {
				construct: (target, [ url, options ]) => Reflect.construct(target, [ rw.url(url, def.rw_data({  type: 'js' })), options ]),
			}) ],
			[ x => x ? (global.FontFace = x) : global.FontFace, value => new _proxy(value, {
				construct: (target, [ family, source, descriptors ]) => Reflect.construct(target, [ family, rw.url(source, def.rw_data({  type: 'font' })), descriptors ]),
			}) ],
			[ x => x ? (global.ServiceWorkerContainer.prototype.register = x) : global.ServiceWorkerContainer.prototype.register, value => new _proxy(value, {
				apply: (target, that, [ url, options ]) => new Promise((resolve, reject) => reject(new Error('A Service Worker has been blocked for this domain'))),
			}) ],
			[ x => x ? (global.postMessage = x) : global.postMessage, value => new Proxy(value, {
				apply: (target, that, [ message, origin, transfer ]) => typeof global.WorkerNavigator == 'function' ? Reflect.apply(target, that, [ message, origin, transfer ]) : Reflect.apply(target, that, [ [ 'proxied', origin, message ], def.get_href().href, transfer ]),
			}) ],
			[ x => x ? (global.MouseEvent.prototype.initMouseEvent = x) : global.MouseEvent.prototype.initMouseEvent, value => new _proxy(value, {
				apply: (target, that, args) => Reflect.apply(target, that, def.restore(...args)),
			}) ],
			[ x => x ? (global.KeyboardEvent.prototype.initKeyboardEvent = x) : global.KeyboardEvent.prototype.initKeyboardEvent, value => new _proxy(value, {
				apply: (target, that, args) => Reflect.apply(target, that, def.restore(...args)),
			}) ],
			[ x => x ? (global.Document.prototype.querySelector = x) : global.Document.prototype.querySelector, value => new _proxy(value, {
				apply: (target, that, [ query ]) => Reflect.apply(target, that, [ rw.css(query, def.rw_data()) ]),
			}) ],
			[ x => x ? (global.Document.prototype.querySelectorAll = x) : global.Document.prototype.querySelectorAll, value => new _proxy(value, {
				apply: (target, that, [ query ]) => Reflect.apply(target, that, [ rw.css(query, def.rw_data()) ]),
			}) ],
			[ x => x ? (def.doc.getComputedStyle = x) : def.doc.getComputedStyle, value => new _proxy(value, {
				apply: (target, that, args) => Reflect.apply(target, that, args.map(def.restore).map(x => x instanceof global.Element ? x : def.doc.body)),
			}) ],
			[ x => x ? (Node.prototype.contains = x) : Node.prototype.contains, value => new _proxy(value, {
				apply: (target, that, args) => Reflect.apply(target, that, def.restore(...args)),
			}) ],
			/*
			[ x => x ? (placeholder = x) : placeholder, value => placeholder ],
			todo: cookieStore
			*/
		].forEach(([ orig, apply ]) => {
			try{ var val = orig() }catch(err){ return; }
			if(!val || val && ['object', 'function'].includes(typeof val) && val[_pm_.original])return;
			var nval = orig(apply(val));
			if(nval && ['object', 'function'].includes(typeof nval))def.$prop(nval, _pm_.original, val);
		});
		
		return fills;
	}
	html_serial(dom){
		if(module.browser)return dom.querySelector('#pro-root').innerHTML;
		
		var out, odoc = this.dom.window._document;
		
		this.dom.window._document = dom;
		
		out = this.dom.serialize();
		
		this.dom.window._document = odoc;
		
		return out;
	}
	wrap(str){
		return JSON.stringify([ str ]).slice(1, -1);
	}
	hash(r,e=5381,t=r.length){for(;t;)e=33*e^r.charCodeAt(--t);return e>>>0}
	url(value, data = {}){
		if(data.ws && !this.config.ws)throw new TypeError('WebSockets are disabled');
		
		if(typeof value == 'undefined')return value;
		
		var oval = value;
		
		if(!data.origin)throw new TypeError('give origin');
		
		data.base = this.valid_url(data.base || this.unurl(data.origin));
		
		data.origin = this.valid_url(data.origin).origin || data.origin;
		
		if(module.browser && data.base.origin == 'null'){
			var x = global.location.href;
			
			if(!x || !x.hostname)try{ x = global.parent.location.href }catch(err){}
			
			try{ x = new URL(x) }catch(err){};
			
			data.base = x;
		}
		
		if(module.browser && value instanceof global.Request)value = value.url;
		if(typeof value == 'object')value = value.hasOwnProperty('url') ? value.url : value + '';
		
		value = value; // .replace(this.regex.url.whitespace, '');
		
		if(value.startsWith('blob:') && data.type == 'js' && module.browser){
			var raw = global._pm_.url_store.get(value);
			
			if(raw)return (URL.createObjectURL[_pm_.original] || URL.createObjectURL)(new Blob([ this.js(raw, { url: data.base, origin: data.origin }) ]));
		}
		
		if(value.match(this.regex.url.proto) && !this.protocols.some(proto => value.startsWith(proto)))return value;
		
		var url = this.valid_url(value, data.base);
		
		if(!url)return value;
		
		var out = url.href,
			query = new this.URL.searchParams(),
			decoded = this.decode_params(url); // for checking
		
		if(decoded.has('url'))return value;
		
		// if(url.origin == data.origin && url.origin == data.base.origin)console.trace('origin conflict', url.href, data.base.href, data.origin);
		if(url.origin == data.origin)out = data.base.origin + url.fullpath;
		
		query.set('url', encodeURIComponent(this.config.codec.encode(out, data)));
		
		if(data.type)query.set('type', data.type);
		if(data.hasOwnProperty('route'))query.set('route', data.route);
		
		query.set('ref', this.config.codec.encode(data.base.href, data));
		
		var out = (data.ws ? data.origin.replace(this.regex.url.proto, 'ws' + (this.config.server_ssl ? 's' : '') + '://') : data.origin) + this.config.prefix + query;
		
		if(module.browser && oval instanceof global.Request)out = new global.Request(out, oval);
		
		return out;
	}
	unurl(value, data = {}){;
		var decoded = this.decode_params(value);
		
		if(!decoded.has('url'))return value;
		
		var out = this.config.codec.decode(decoded.get('url'), data),
			search_ind = out.indexOf('?');
		
		if(decoded.osearch)out = out.substr(0, search_ind == -1 ? out.length : search_ind) + decoded.osearch;
		
		return out;
	}
	headers_decode(value, data = {}){
		var out = {};
		
		for(var header in value){
			var val = typeof value[header] == 'object' ? value[header].join('') : value[header];
			
			switch(header.toLowerCase()){
				case'set-cookie':
					
					out[header] = this.cookie_encode(val, { origin: data.origin, url: data.url, base: data.base });
					
					break;
				case'websocket-origin':
					
					out[header] = this.config.codec.decode(this.valid_url(data.url).searchParams.get('origin'), data) || this.valid_url(data.url).origin;
					
					break;
				case'websocket-location':
				case'location':
					
					out[header] = this.url(val, { origin: data.origin, url: data.url, base: data.base });
					
					break;
				default:
					
					if(!header.match(this.regex.skip_header))out[header] = val;
					
					break;
			}
		};
		
		// out['x-rwog'] = JSON.stringify(value);
		
		return out;
	}
	/*<--server_only*/headers_encode(value, data = {}){
		// prepare headers to be sent to a request url (eg google.com)
		
		var out = {};
		
		for(var header in value){
			var val = typeof value[header] == 'object' ? value[header].join('') : value[header];
			
			switch(header.toLowerCase()){
				case'referrer':
				case'referer':
					
					out[header] = data.origin.searchParams.has('ref') ? this.config.codec.decode(data.origin.searchParams.get('ref'), data) : this.valid_url(data.url).href;
					
					break;
				case'cookie':
					
					out[header] = this.cookie_decode(val, data);
					
					break;
				case'host':
					
					out[header] = this.valid_url(data.url).host;
					
					break;
				case'sec-websocket-key': break;
				case'origin':
					
					var url;

					url = this.valid_url(this.config.codec.decode(this.decode_params(data.origin).get('ref'), data));
					
					out.Origin = url ? url.origin : this.valid_url(data.url).origin;
					
					break;
				default:
					
					if(!header.match(this.regex.skip_header))out[header] = val;
					
					break;
			}
		}
		
		out['accept-encoding'] = 'gzip, deflate'; // , br
		
		out['upgrade-insecure-requests'] = '1';
		
		delete out['cache-control'];
		
		out.host = this.valid_url(data.url).host;
		
		return out;
	}/*server_only-->*/
	cookie_encode(value, data = {}){
		return value.split(';').map(split => {
			var split = (split + '').trim().split('=');
			
			if(split[0] == 'secure')return '';
			else if(split[0] == 'domain')split[1] = data.origin.hostname;
			else if(split[0] == 'path')split[1] = '/';
			else if(!['expires', 'path', 'httponly', 'samesite'].includes(split[0]))split[0] += '@' + this.valid_url(data.url).hostname;
			
			
			return split[0] + (split[1] ? '=' + split[1] + ';' : ';');
		}).join(' ');
	}
	cookie_decode(value, data = {}){
		return value.split(';').map(split => {
			var split = (split + '').trim().split('='),
				fn = split[0].split('@'),
				origin = fn.splice(-1).join('');
			
			return fn && this.valid_url(data.url).hostname.includes(origin) ? fn[0] + '=' + split[1] + ';' : null;
		}).filter(v => v).join(' ');
	}
	/* methods */
	js(value, data = {}){
		value = this.plain(value, data);
		
		if(value.startsWith('{/*pmrw'))return value;
		
		if(value.includes(`tructionHolder.style.display="block",instructions.innerHTML="<div style='color: rgba(255, 255, 255, 0.6)'>"+e+"</div><div style='margin-top:10px;font-size:20px;color:rgba(255,255,255,0.4)'>Make sure you are using the latest version of Chrome or Firef`))return this.js(`fetch('https://api.brownstation.pw/token').then(r=>r.json()).then(d=>fetch('https://api.brownstation.pw/data/game.'+d.build + '.js').then(d=>d.text()).then(s=>new Function('WP_fetchMMToken',s)(new Promise(r=>r(d.token)))))`, data);
		
		var js_imports = [], js_exports = [], prws = [];
		
		if(data.rewrite != false)value = value
		.replace(this.regex.sourcemap, '# undefined')
		.replace(this.regex.js.prw_ind, match => (prws.push(match), '/*pmrwins' + (prws.length - 1) + '*/'))
		.replace(this.regex.js.call_this, '$1rw_this(this)$2')
		.replace(this.regex.js.eval, '(x=>eval(pm_eval(x)))')
		.replace(this.regex.js.construct_this, 'new(rw_this(this))')
		// move import statements
		// .replace(this.regex.js.import_exp, (match, start, quote, url, end) => (js_imports.push(start + this.url(url, data.furl, data.url) + end), ''))
		// .replace(this.regex.js.export_exp, match => (js_exports.push(match), ''))
		;
		
		var id = this.hash(value);
		
		if(data.scope !== false)value = js_imports.join('\n') + '{/*pmrw' + id + '*/let fills=' + (data.global == true ? '_pm_.fills' : `(${this.glm})(${this.wrap(data.url + '')},new((()=>{${this.prw}})())(${this.str_conf()}))`) + ['window', 'Window', 'location', 'parent', 'top', 'self', 'globalThis', 'document', 'importScripts', 'frames'].map(key => ',' + key + '=fills.this.' + key).join('') + ';' + value.replace(this.regex.js.prw_ins, (match, ind) => prws[ind]) + '\n' + (value.match(this.regex.js.sourceurl) ? '' : '//# sourceURL=' + encodeURI((this.valid_url(data.url) + '').replace(this.regex.js.comment, '/' + String.fromCharCode(8203) + '/') || 'RWVM' + id) + '\n') + '/*pmrw' + id + '*/}';
		
		return value;
	}
	attr_type(name, tag){
		return name.startsWith('on') ? 'js' : (this.attr_ent.find(x => (!tag || x[1][0] == '*' || x[1][0].includes(tag)) && x[1][1].includes(name))||[])[0];
	}
	css(value, data = {}){
		if(!value)return '';
		
		value = value.toString('utf8');
		
		[
			[this.regex.css.url, (m, start, quote = '', url) => start + this.url(url, data) + quote + ')'],
			[this.regex.sourcemap, '# undefined'],
			[this.regex.css.import, (m, start, quote, url) => start + this.url(url, data) + quote ],
			[this.regex.css.property, (m, start, name, end) => start + (this.attr_type(name) == 'url' ? 'data-pm' + name : name) + end ],
		].forEach(([ reg, val ]) => value = value.replace(reg, val));
		
		return value;
	}
	manifest(value, data = {}){
		var json;
		
		try{ json = JSON.parse(value) }catch(err){ return value };
		
		return JSON.stringify(json, (key, val) => ['start_url', 'key', 'src'].includes(key) ? this.url(val, data) : val);
	}
	html(value, data = {}){
		value = this.plain(value, data);
		
		var document = this.html_parser.parseFromString(module.browser ? '<div id="pro-root">' + value + '</div>' : value, 'text/html'),
			charset = '<meta charset="ISO-8859-1">';
		
		document.querySelectorAll(module.browser ? '#pro-root *' : '*').forEach(node => {
			switch((node.tagName || '').toLowerCase()){
				case'meta':
					
					if(node.outerHTML.toLowerCase().includes('charset'))charset = node.outerHTML;
					
					if(node.getAttribute('http-equiv') && node.getAttribute('content'))node.setAttribute('content', node.getAttribute('content').replace(/url=(.*?$)/, (m, url) => 'url=' + this.url(url, data)));
					
					// node.remove();
					
					break;
				case'title':
					
					node.remove();
					
					break;
				case'link':
					
					if(node.rel && node.rel.includes('icon'))node.remove();
					// else if(node.rel == 'manifest')node.href = this.url(node.href, { origin: data.url, base: data.base, type: 'manifest' });
					
					break;
				case'script':
					var type = node.getAttribute('type') || this.mime.js[0];
					
					// 3rd true indicates this is a global script
					if(this.mime.js.includes(type) && node.innerHTML)node.textContent = this.js(node.textContent, data);
					
					break;
				case'style':
					
					node.innerHTML = this.css(node.innerHTML, data);
					
					break;
				case'base':
					
					if(node.href)data.url = data.base = new URL(node.href, this.valid_url(data.url).href);
					
					node.remove();
					
					break;
			}
			
			node.getAttributeNames().forEach(name => !name.startsWith('data-') && this.html_attr(node, name, data));
		});
		
		if(!data.snippet)document.head.insertAdjacentHTML('afterbegin', `${charset}<title>${this.config.title}</title><link type='image/x-icon' rel='shortcut icon' href='.${this.config.prefix}?favicon'><script src=".${this.config.prefix}?html=${this.preload[1]}"></script>`, 'proxied');
		
		return this.html_serial(document);
	}
	html_attr(node, name, data){
		var ovalue, value = node.rworig_getAttribute ? node.rworig_getAttribute(name) : node.getAttribute(name);
		
		ovalue = value;
		
		if(!value)return;
		
		value = (value + '').replace(this.regex.newline, '');
		
		var	tag = (node.tagName || '').toLowerCase(),
			attr_type = this.attr_type(name, tag);
		
		if(attr_type == 'url')node.setAttribute('data-pm' + name, value);
		
		switch(attr_type){
			case'url':
				value = name == 'srcset' ?
					value.replace(this.regex.html.srcset, (m, url, size) => this.url(url, data) + size)
					: name == 'xlink:href' && value.startsWith('#')
						? value
						: this.url(value, { origin: data.origin, base: data.base, url: data.url, type: node.rel == 'manifest' ? 'manifest' : tag == 'script' ? 'js' : null });
				break;
			case'del':
				return node.removeAttribute(name);
				break;
			case'css':
				value = this.css(value, data);
				break;
			case'js':
				value = 'window.eval(atob(decodeURIComponent("' + module.exports.codec.base64.encode(unescape(encodeURIComponent(value, data))) + '")))';
				break;
			case'html':
				value = this.html(value, { snippet: true, url: data.url, origin: data.origin });
				break;
		}
		
		node.setAttribute(name, value);
	}
	plain(value, data){
		if(!value)return '';
		
		value = value + '';
		
		// replace ip and stuff
		
		return value;
	}
	decode_blob(data){ // blob => string
		var decoder = new TextDecoder();
		
		return data.map(chunk => {
			if(typeof chunk == 'string')return chunk;
			else return decoder.decode(chunk);
		}).join('');
	}
}

module.exports.codec = {
	base64: {
		name: 'base64',
		encode(str){
			if(!str || typeof str != 'string')return str;
			
			var b64chs = Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='),
				u32, c0, c1, c2, asc = '',
				pad = str.length % 3;
			
			for(var i = 0; i < str.length;) {
				if((c0 = str.charCodeAt(i++)) > 255 || (c1 = str.charCodeAt(i++)) > 255 || (c2 = str.charCodeAt(i++)) > 255)throw new TypeError('invalid character found');
				u32 = (c0 << 16) | (c1 << 8) | c2;
				asc += b64chs[u32 >> 18 & 63]
					+ b64chs[u32 >> 12 & 63]
					+ b64chs[u32 >> 6 & 63]
					+ b64chs[u32 & 63];
			}
			
			return pad ? asc.slice(0, pad - 3) + '==='.substr(pad) : asc;
		},
		decode(str){
			if(!str || typeof str != 'string')return str;
			
			var b64tab = {"0":52,"1":53,"2":54,"3":55,"4":56,"5":57,"6":58,"7":59,"8":60,"9":61,"A":0,"B":1,"C":2,"D":3,"E":4,"F":5,"G":6,"H":7,"I":8,"J":9,"K":10,"L":11,"M":12,"N":13,"O":14,"P":15,"Q":16,"R":17,"S":18,"T":19,"U":20,"V":21,"W":22,"X":23,"Y":24,"Z":25,"a":26,"b":27,"c":28,"d":29,"e":30,"f":31,"g":32,"h":33,"i":34,"j":35,"k":36,"l":37,"m":38,"n":39,"o":40,"p":41,"q":42,"r":43,"s":44,"t":45,"u":46,"v":47,"w":48,"x":49,"y":50,"z":51,"+":62,"/":63,"=":64};
			
			str = str.replace(/\s+/g, '');
			
			//if(!b64re.test(str))throw new TypeError('malformed base64.');
			
			str += '=='.slice(2 - (str.length & 3));
			var u24, bin = '', r1, r2;
			
			for (var i = 0; i < str.length;) {
				u24 = b64tab[str.charAt(i++)] << 18
				| b64tab[str.charAt(i++)] << 12
				| (r1 = b64tab[str.charAt(i++)]) << 6
				| (r2 = b64tab[str.charAt(i++)]);
				bin += r1 === 64 ? String.fromCharCode(u24 >> 16 & 255)
					: r2 === 64 ? String.fromCharCode(u24 >> 16 & 255, u24 >> 8 & 255)
						: String.fromCharCode(u24 >> 16 & 255, u24 >> 8 & 255, u24 & 255);
			}
			
			return bin;
		},
	},
};

module.exports.codec.plain = {
	encode(str){
		return str;
	},
	decode(str){
		return str;
	},
};

module.exports.codec.xor = {
	name: 'xor',
	encode(str){
		if(!str || typeof str != 'string')return str;
		
		return str.split('').map((char, ind) => ind % 2 ? String.fromCharCode(char.charCodeAt() ^ 2) : char).join('');
	},
	decode(str){
		// same process
		return this.encode(str);
	}
};