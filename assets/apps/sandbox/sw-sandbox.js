let APP_FILE_MODE = 0;
let STREAMING_MODE = 1;
var streamingMap
var appName;
var appData = null;
var appPort = null;

var streamingFilePath = "";
var streamingAppEntry = new StreamingEntry(-1);
var downloadUrl = null;
let apiRequest = "/peergos-api/v0";
let dataRequest = apiRequest + "/data/";
let formRequest = apiRequest + "/form/";
var host = null;
self.onmessage = event => {
  if (event.data === 'ping') {
    return
  }

  downloadUrl = self.registration.scope + 'intercept-me-nr' + Math.random()
  const data = event.data
  const port = event.ports[0]

  const metadata = new Array(3) // [stream, data, port]
  metadata[1] = data
  metadata[2] = port
  
  let headers = new Headers(data.headers || {})

  let size = Number(headers.get('Content-Length'));
  let disposition = headers.get('Content-Disposition');
  let startIndex = disposition.indexOf("''");
  appName = decodeURIComponent(disposition.substring(startIndex+2, disposition.length))
                        .replaceAll(':','/');
  setupNewApp(port);
  port.postMessage({ download: downloadUrl})

}

function StreamingEntry(fileSize) {
    this.fileSize = fileSize;
    this.mimeType = '';
    this.bytes = new Uint8Array(0);
    this.skip = false;
    this.firstRun = true;
    this.setFileSize = function(fileSize) {
        this.fileSize = fileSize;
    }
    this.setMimeType = function(mimeType) {
        this.mimeType = mimeType;
    }
    this.getFileSize = function() {
        return this.fileSize;
    }
    this.getMimeType = function() {
        return this.mimeType;
    }
    this.setSkip = function() {
        if(this.firstRun) {
            this.firstRun = false;
        } else {
            this.skip = true;
        }
    }
    this.getSkip = function() {
        return this.skip;
    }
    this.reset = function() {
        this.bytes = new Uint8Array(0);
        this.skip = false;
    }
    this.enqueue = function(data) {

        streamingAppEntry.reset();
        var offset = 1;
        let filePathSize = data[offset];
        offset = offset + 1;
        let filePathBytes = data.subarray(offset, filePathSize + offset);
        let filePath = new TextDecoder().decode(filePathBytes);
        if (filePath != streamingFilePath) {
            streamingFilePath = filePath;
        }
        offset =  offset + filePathSize;
        let mimeTypeSize = data[offset];
        offset = offset + 1;
        let mimeTypeBytes = data.subarray(offset, mimeTypeSize + offset);
        let mimeType = new TextDecoder().decode(mimeTypeBytes);
        offset =  offset + mimeTypeSize;

        let sizeHigh = readUnsignedLeb128(data.subarray(offset, offset + 4));
        offset += unsignedLeb128Size(sizeHigh);
        let sizeLow = readUnsignedLeb128(data.subarray(offset, offset + 4));
        offset += unsignedLeb128Size(sizeLow);
        var low = sizeLow;
        if (low < 0) low = low + Math.pow(2, 32);
        let fileSize = low + (sizeHigh * Math.pow(2, 32));
        streamingAppEntry.setFileSize(fileSize);
        streamingAppEntry.setMimeType(mimeType);

        let moreData = data.subarray(offset)
        const currentBytes = this.bytes;
        const combinedSize = currentBytes.byteLength + moreData.byteLength;
        var newStore = new Uint8Array(combinedSize);
        newStore.set(currentBytes);
        newStore.set(moreData, currentBytes.byteLength);
        this.bytes = newStore;
    }
}

function AppData() {
    this.resultMap = new Map();
    this.fileMap = new Map();
    this.mimeTypeMap = new Map();
    this.fileStatusMap = new Map();
    this.isReady = function(fullPath) {
        var status = this.fileStatusMap.get(fullPath)
        return status == true;
    }
    this.getAndRemoveFile = function(fullPath) {
        let fileData = this.fileMap.get(fullPath);
        let mimeType = this.mimeTypeMap.get(fullPath);
        let result = this.resultMap.get(fullPath);

        this.resultMap.delete(fullPath);
        this.fileMap.delete(fullPath);
        this.mimeTypeMap.delete(fullPath);
        this.fileStatusMap.delete(fullPath);
        return {file: fileData, mimeType: mimeType, statusCode: result};
    }
    this.convertStatusCode = function(code) {
        if (code == '0') {        //              APP_FILE_MODE = 0
            return 200;
        } else if (code == '2') { //            FILE_NOT_FOUND: 2,
            return 404;
        } else if (code == '3') { //            ACTION_FAILED: 3,
            return 400;
        } else if (code == '4') { //            DELETE_SUCCESS: 4,
            return 204;
        } else if (code == '5') { //            DIRECTORY_NOT_FOUND: 5,
            return 404;
        } else if (code == '6') { //            CREATE_SUCCESS: 6,
            return 201;
        } else if (code == '7') { //            UPDATE_SUCCESS: 7,
            return 200;
        } else if (code == '8') { //            GET_SUCCESS: 8,
            return 200;
        } else if (code == '9') { //            PATCH_SUCCESS: 9,
            return 204;
        } else if (code == '10') { //            NAVIGATE_TO: 10,
            return 404;
        } else {
            return 400;
        }
    }
    this.enqueue = function(moreData) {
    	let mode = moreData[0];
        var offset = 1;
        let filePathSize = moreData[offset];
        var offset = offset + 1;
        let filePathBytes = moreData.subarray(offset, filePathSize + offset);
        let filePath = new TextDecoder().decode(filePathBytes);

        offset =  offset + filePathSize;
        let mimeTypeSize = moreData[offset];
        offset = offset + 1;
        let mimeTypeBytes = moreData.subarray(offset, mimeTypeSize + offset);
        let mimeType = new TextDecoder().decode(mimeTypeBytes);
        offset =  offset + mimeTypeSize;

        this.mimeTypeMap.set(filePath, mimeType);
        this.resultMap.set(filePath, this.convertStatusCode(mode));

        var file = this.fileMap.get(filePath)
        if(file == null) {
            file = new Uint8Array(0);
        }
        const combinedSize = file.byteLength + moreData.byteLength - offset;
        var newFile = new Uint8Array(combinedSize);
        newFile.set(file);
        newFile.set(moreData.subarray(offset), file.byteLength);
        this.fileMap.set(filePath, newFile);
        this.fileStatusMap.set(filePath, true);
    }
}
function setupNewApp(port) {
    appData = new AppData();
    appPort = port;
    port.onmessage = ({ data }) => {
        if (data != 'end' && data != 'abort') {
            if (data[0] == STREAMING_MODE) {
                streamingAppEntry.enqueue(data);
            } else {
                appData.enqueue(data);
            }
        }
    }
}

self.addEventListener('install', event =>  {
    self.skipWaiting();
});
self.addEventListener('activate', event => {
    clients.claim();
});

const maxBlockSize = 1024 * 1024 * 5;
const oneMegBlockSize = 1024 * 1024 * 1;

let csp = "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; style-src-elem 'self' 'unsafe-inline' data:; font-src 'self';img-src 'self' data: blob:;connect-src 'self' data:; media-src 'self' data:;";

self.onfetch = event => {
    const url = event.request.url;
    if (url.endsWith('/ping')) {
      return event.respondWith(new Response('pong', {
        headers: { 'Access-Control-Allow-Origin': '*' }
      }));
    }
    if (appPort == null) {
        return;
    }
    if (url == downloadUrl) {
      return event.respondWith(new Response('', {
        headers: { 'Access-Control-Allow-Origin': '*' }
      }))
    }
    const requestedResource = new URL(url);
    if (host == null) {
        host = requestedResource.host;
    }
    if (requestedResource.host != host) {
        return event.respondWith(new Response('', {
            status: 404
        }));
    }
    let filePath = decodeURI(requestedResource.pathname);
    if (filePath.startsWith('/peergos/')) {
        let respHeaders = [
            ['Content-type', 'text/html'],
            ['content-security-policy', csp],
            ['Cross-Origin-Embedder-Policy', 'require-corp'],
            ['Cross-Origin-Opener-Policy', 'same-origin'],
            ['Cross-Origin-Resource-Policy', 'same-origin'],
            ['Origin-Agent-Cluster', '?1'],
            ['x-xss-protection', '1; mode=block'],
            ['x-dns-prefetch-control', 'off'],
            ['x-content-type-options', 'nosniff'],
            ['permissions-policy', 'interest-cohort=(), geolocation=(), gyroscope=(), magnetometer=(), accelerometer=(), microphone=(), camera=(self), fullscreen=(self)']
        ];
        let redirectHTML= '<html><body><script>'
        + 'let loc = window.location;'
        + 'let index = loc.pathname.indexOf("/", 1);'
        + 'let pathname = loc.pathname.substring(index);'
        + 'let addr = loc.origin + pathname + loc.search;'
        + 'console.log("addr=" + addr);'
        + 'window.location.replace(addr);'
        + '</script></body></html>';
        return event.respondWith(new Response(redirectHTML,
            { headers: respHeaders }));
    }
    if (event.request.headers.get('range')) {
        if (filePath != streamingFilePath) {
            streamingFilePath = filePath;
            streamingAppEntry = new StreamingEntry(-1);
        }
        let streamingEntry = streamingAppEntry;
        let port = appPort;

        const bytes = /^bytes\=(\d+)\-(\d+)?$/g.exec(
            event.request.headers.get('range')
        );
        const start = Number(bytes[1]);
        const desiredEnd = Number(bytes[2]);
        var firstBlockSize = oneMegBlockSize - 1;
        if (desiredEnd == 1 || bytes[2] == null) {
            firstBlockSize = 1;
        }
        var end = streamingEntry.firstRun ? firstBlockSize : alignToChunkBoundary(start, Number(bytes[2]));
        if(streamingEntry.fileSize >0 && end > streamingEntry.fileSize - 1) {
            end = streamingEntry.fileSize - 1;
        }
        const seekHi = (start - (start % Math.pow(2, 32)))/Math.pow(2, 32);
        const seekLength = end-start + 1;
        streamingEntry.setSkip();
        port.postMessage({ seekHi: seekHi, seekLo: start, seekLength: seekLength, streamFilePath: filePath })
        return event.respondWith(returnRangeRequest(start, end, streamingEntry))
    } else {
        let params = new Map();
        requestedResource.searchParams.forEach( (value, key) => {
            params.set(key, decodeURI(value));
        });

        let method = event.request.method;
        if (method == 'OPTIONS' || method == 'HEAD') {
            return event.respondWith(new Response('Not Implemented!', {
                status: 400
            }));
        } else {
            var restFilePath = filePath;
            var isFromRedirect = false;
            if (filePath.startsWith(dataRequest)) {
                restFilePath = restFilePath.substring(dataRequest.length);
            } else if (filePath.startsWith(formRequest)) {
                if (method != 'POST') {
                    return new Response('Unknown form action!', {status: 400})
                }
                restFilePath = restFilePath.substring(formRequest.length);
            } else {
                if (event.request.referrer.length > 0) {
                    let fromUrl = new URL(event.request.referrer);
                    if (fromUrl.pathname.startsWith('/peergos/')) {
                        isFromRedirect = true;
                    }
                }
            }
            let uniqueId = method == 'GET' && restFilePath ==  filePath ? '' : uuid();
            if (uniqueId == '' && method != 'GET') {
                return new Response('Unexpected url', {status: 400})
            }
            if (method == 'PATCH' && "append" != event.request.headers.get('X-Update-Range').toLowerCase()) {
                return new Response('X-Update-Range:append header expected', {status: 400})
            }
            return event.respondWith(
                (async function() {
                    var formData = null;
                    var buffer = null;
                    if (method == 'POST') {
                        formData = await event.request.clone().formData().catch(err => null);
                        if (formData != null) {
                            let encoder = new TextEncoder();
                            buffer = encoder.encode(formToJSON(formData));
                        }
                    }
                    if (formData == null) {
                        buffer = await event.request.clone().arrayBuffer().catch(err => err)
                        if (buffer instanceof Error) {
                            return new Response('Unexpected error!', {status: 400})
                        }
                    }
                    appPort.postMessage({ filePath: restFilePath, requestId: uniqueId, apiMethod: method, bytes: buffer,
                        hasFormData: formData != null, params: params, isFromRedirect: isFromRedirect});
                    return returnAppData(method, restFilePath, uniqueId);
                })()
            )
        }
    }
}
//https://stackoverflow.com/questions/105034/how-to-create-guid-uuid
function uuid() {
  return '-' + ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}
function returnAppData(method, filePath, uniqueId) {
    return new Promise(function(resolve, reject) {
        let key = filePath + uniqueId;
        let pump = () => {
            if (!appData.isReady(key)) {
                setTimeout(pump, 100)
            } else {
                let fileData = appData.getAndRemoveFile(key)
                resolve(fileData);
            }
        }
        pump()
    }).then(function(fileData, err) {
        let respHeaders = [
            ['content-security-policy', csp],
            ['Cross-Origin-Embedder-Policy', 'require-corp'],
            ['Cross-Origin-Opener-Policy', 'same-origin'],
            ['Cross-Origin-Resource-Policy', 'same-origin'],
            ['Origin-Agent-Cluster', '?1'],
            ['x-xss-protection', '1; mode=block'],
            ['x-dns-prefetch-control', 'off'],
            ['x-content-type-options', 'nosniff'],
            ['referrer-policy', 'no-referrer'],
            ['permissions-policy', 'interest-cohort=(), geolocation=(), gyroscope=(), magnetometer=(), accelerometer=(), microphone=(), camera=(self), fullscreen=(self)']
        ];
        if (fileData.statusCode == 201) {
            //https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/201
            let location = new TextDecoder().decode(fileData.file);
            respHeaders.push(['location', location]);
            return new Response(null, {
                status: fileData.statusCode,
                headers: respHeaders
            });
        } else if (method == 'PATCH' && fileData.statusCode == 204) {
            //https://developer.mozilla.org/en-US/docs/Web/HTTP/Methods/PATCH
            let location = new TextDecoder().decode(fileData.file);
            respHeaders.push(['Content-Location', location]);
            return new Response(null, {
                status: fileData.statusCode,
                headers: respHeaders
            });
        } else {
            respHeaders.push(['Content-Type', fileData.mimeType]);
            respHeaders.push(['Content-Length', fileData.file.byteLength]);
            return new Response(fileData.file.byteLength == 0 ? null : fileData.file, {
                status: fileData.statusCode,
                headers: respHeaders
            });
        }
    });
}
function alignToChunkBoundary(start, end) {
    if (end) {
        let modifiedEnd = end - start > maxBlockSize ?
            alignToChunkBoundary(start) : end;
        return modifiedEnd;
    } else {
        let endOfRange = ((Math.floor(start / maxBlockSize) + 1) * maxBlockSize) - 1;
        let len = endOfRange - start;
        if(len < oneMegBlockSize) {
            endOfRange = endOfRange + maxBlockSize;
        }
        return endOfRange;
    }
}
//https://stackoverflow.com/questions/41431322/how-to-convert-formdata-html5-object-to-json
function formToJSON( formData ) {
  let output = {};
  formData.forEach(
    ( value, key ) => {
      // Check if property already exist
      if ( Object.prototype.hasOwnProperty.call( output, key ) ) {
        let current = output[ key ];
        if ( !Array.isArray( current ) ) {
          // If it's not an array, convert it to an array.
          current = output[ key ] = [ current ];
        }
        current.push( value ); // Add the new value to the array.
      } else {
        output[ key ] = value;
      }
    }
  );
  return JSON.stringify( output );
}
function returnRangeRequest(start, end, streamingEntry) {
    return new Promise(function(resolve, reject) {
        let pump = (currentCount) => {
            const store = streamingEntry.bytes;
            if (streamingEntry.getSkip() || (end > 0 && store.byteLength != end-start + 1) || store.byteLength == 0) {
                if(currentCount > 30) {
                    resolve(null);
                } else {
                    setTimeout(function(){pump(++currentCount);}, 1000);
                }
            } else {
                resolve(store);
            }
        }
        pump(0);
    }).then(function(arrayBuffer, err) {
        const fileSize = streamingEntry.getFileSize();
        const mimeType = streamingEntry.getMimeType();

        let respHeaders = [
            ['content-security-policy', csp],
            ['content-security-policy', 'require-corp'],
            ['Cross-Origin-Embedder-Policy', 'require-corp'],
            ['Cross-Origin-Opener-Policy', 'same-origin'],
            ['Cross-Origin-Resource-Policy', 'same-origin'],
            ['Origin-Agent-Cluster', '?1'],
            ['x-xss-protection', '1; mode=block'],
            ['x-dns-prefetch-control', 'off'],
            ['x-content-type-options', 'nosniff'],
            ['referrer-policy', 'no-referrer'],
            ['permissions-policy', 'interest-cohort=(), geolocation=(), gyroscope=(), magnetometer=(), accelerometer=(), microphone=(), camera=(self), fullscreen=(self)']
        ];
        if (arrayBuffer == null) {
            respHeaders.push(['Content-Range', `*/${fileSize}`]);
            return new Response(null, {
              status: 416,
              statusText: 'Range Not Satisfiable',
              headers: respHeaders
            });
        } else {
            const bytesProvided = start +  arrayBuffer.byteLength - 1;
            respHeaders.push(['content-type', mimeType]);
            respHeaders.push(['accept-ranges', 'bytes']);
            respHeaders.push(['Content-Range', `bytes ${start}-${bytesProvided}/${fileSize}`]);
            respHeaders.push(['content-length', arrayBuffer.byteLength]);

            return new Response(arrayBuffer, {
              status: 206,
              statusText: 'Partial Content',
              headers: respHeaders
            });
        }
    });
}
function unsignedLeb128Size(value) {
    var remaining = value >> 7;
    var count = 0;
    while (remaining != 0) {
        remaining >>= 7;
        count++;
    }
    return count + 1;
}
function readUnsignedLeb128(value) {
    var result = 0;
    var cur;
    var count = 0;
    do {
        cur = value[count];
        result |= (cur & 0x7f) << (count * 7);
        count++;
    } while (((cur & 0x80) == 0x80) && count < 5);
    if ((cur & 0x80) == 0x80) {
        throw new Error("invalid LEB128 sequence");
    }
    return result;
}