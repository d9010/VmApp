'use strict';
// AWS Signature Version 4 against the examples AWS publishes. Where a vector below says "S3 documentation" it is from
// "Authenticating Requests: Using the Authorization Header (AWS Signature Version 4)" and "...Using Query Parameters";
// "IAM documentation" is the ListUsers example of "Create a signed request"; "test suite" is the SigV4 test suite
// (aws-sig-v4-test-suite). A wrong signature here would also fail against a real S3, which is why the vectors are the
// first thing checked.
const test = require('node:test');
const assert = require('node:assert/strict');
const sig = require('../../registry/lib/sigv4');

const EXAMPLE = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 's3' };
const SUITE = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service' };

test('signing key derivation (IAM documentation)', () => {
  const k = sig.signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830', 'us-east-1', 'iam');
  assert.equal(k.toString('hex'), 'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9');
});

test('IAM documentation: GET ListUsers', () => {
  const r = sig.signRequest(Object.assign({
    method: 'GET',
    url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', 'X-Amz-Date': '20150830T123600Z' },
  }, SUITE, { service: 'iam' }));
  assert.equal(r.canonicalRequest, [
    'GET', '/', 'Action=ListUsers&Version=2010-05-08',
    'content-type:application/x-www-form-urlencoded; charset=utf-8', 'host:iam.amazonaws.com', 'x-amz-date:20150830T123600Z', '',
    'content-type;host;x-amz-date', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ].join('\n'));
  assert.equal(sig.sha256Hex(r.canonicalRequest), 'f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59');
  assert.equal(r.signature, '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  assert.equal(r.signedHeaders, 'content-type;host;x-amz-date');
  assert.match(r.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/iam\/aws4_request,SignedHeaders=content-type;host;x-amz-date,Signature=5d672d79/);
});

test('test suite: get-vanilla and post-vanilla', () => {
  let r = sig.signRequest(Object.assign({ method: 'GET', url: 'https://example.amazonaws.com/', headers: { 'X-Amz-Date': '20150830T123600Z' } }, SUITE));
  assert.equal(r.canonicalRequest, 'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(r.stringToSign, 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63');
  assert.equal(r.signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  r = sig.signRequest(Object.assign({ method: 'POST', url: 'https://example.amazonaws.com/', headers: { 'X-Amz-Date': '20150830T123600Z' } }, SUITE));
  assert.equal(r.signature, '5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b');
});

test('test suite: get-vanilla-query-order-key-case (query parameters are sorted)', () => {
  const r = sig.signRequest(Object.assign({ method: 'GET', url: 'https://example.amazonaws.com/?Param2=value2&Param1=value1', headers: { 'X-Amz-Date': '20150830T123600Z' } }, SUITE));
  assert.match(r.canonicalRequest, /^GET\n\/\nParam1=value1&Param2=value2\n/);
  assert.equal(r.signature, 'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500');
});

test('S3 documentation: GET Object with a Range header', () => {
  const r = sig.signRequest(Object.assign({
    method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', date: '20130524T000000Z', headers: { Range: 'bytes=0-9' },
  }, EXAMPLE));
  assert.equal(r.canonicalRequest, [
    'GET', '/test.txt', '', 'host:examplebucket.s3.amazonaws.com', 'range:bytes=0-9',
    'x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date:20130524T000000Z', '',
    'host;range;x-amz-content-sha256;x-amz-date', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ].join('\n'));
  assert.equal(sig.sha256Hex(r.canonicalRequest), '7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972');
  assert.equal(r.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.equal(r.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('S3 documentation: PUT Object ("$" in the key is encoded once, extra signed headers)', () => {
  const body = 'Welcome to Amazon S3.';
  const hash = sig.sha256Hex(body);
  assert.equal(hash, '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
  const r = sig.signRequest(Object.assign({
    method: 'PUT', url: 'https://examplebucket.s3.amazonaws.com/test$file.text', date: '20130524T000000Z', payloadHash: hash,
    headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
  }, EXAMPLE));
  assert.equal(r.canonicalRequest, [
    'PUT', '/test%24file.text', '', 'date:Fri, 24 May 2013 00:00:00 GMT', 'host:examplebucket.s3.amazonaws.com',
    `x-amz-content-sha256:${hash}`, 'x-amz-date:20130524T000000Z', 'x-amz-storage-class:REDUCED_REDUNDANCY', '',
    'date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class', hash,
  ].join('\n'));
  assert.equal(sig.sha256Hex(r.canonicalRequest), '9e0e90d9c76de8fa5b200d8c849cd5b8dc7a3be3951ddb7f6a76b4158342019d');
  assert.equal(r.signature, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
});

test('S3 documentation: GET Bucket Lifecycle ("?lifecycle" is a parameter without a value)', () => {
  const r = sig.signRequest(Object.assign({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/?lifecycle', date: '20130524T000000Z' }, EXAMPLE));
  assert.equal(r.canonicalRequest.split('\n')[2], 'lifecycle=');
  assert.equal(r.signature, 'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
});

test('S3 documentation: GET Bucket (List Objects) with two query parameters', () => {
  const r = sig.signRequest(Object.assign({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J', date: '20130524T000000Z' }, EXAMPLE));
  assert.equal(r.canonicalRequest.split('\n')[2], 'max-keys=2&prefix=J');
  assert.equal(r.signature, '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
});

test('S3 documentation: presigned GET URL (query-string authentication)', () => {
  const r = sig.presign(Object.assign({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', date: '20130524T000000Z', expiresSec: 86400 }, EXAMPLE));
  assert.equal(r.canonicalRequest, [
    'GET', '/test.txt',
    'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host',
    'host:examplebucket.s3.amazonaws.com', '', 'host', 'UNSIGNED-PAYLOAD',
  ].join('\n'));
  assert.equal(r.signature, 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  assert.equal(r.url,
    'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  assert.equal(r.expiresAt, Date.parse('2013-05-25T00:00:00Z'));
});

test('encoding rules: unreserved characters stay, everything else is %XX in upper case, UTF-8 as bytes', () => {
  assert.equal(sig.uriEncode('AZaz09-_.~'), 'AZaz09-_.~');
  assert.equal(sig.uriEncode("a b!'()*+,;=:@$&/?#[]%"), 'a%20b%21%27%28%29%2A%2B%2C%3B%3D%3A%40%24%26%2F%3F%23%5B%5D%25');
  assert.equal(sig.uriEncode('a/b c', true), 'a/b%20c');
  assert.equal(sig.uriEncode('é中'), '%C3%A9%E4%B8%AD');
});

test('canonical query: sorted by name then value, both encoded; repeated names kept', () => {
  assert.equal(sig.canonicalQuery([['b', '2'], ['a', '2'], ['a', '1'], ['A', 'x y']]), 'A=x%20y&a=1&a=2&b=2');
  assert.equal(sig.canonicalQuery([['prefix', 'events/2026/']]), 'prefix=events%2F2026%2F');
});

test('S3 paths are not normalised or double-encoded; other services normalise and encode again', () => {
  assert.equal(sig.canonicalUri('/bucket/a%20b/c%2Bd', true), '/bucket/a%20b/c%2Bd');
  assert.equal(sig.canonicalUri('/bucket//x/../y', true), '/bucket//x/../y');
  assert.equal(sig.canonicalUri('/a/./b/../c', false), '/a/c');
  assert.equal(sig.canonicalUri('/a%20b/', false), '/a%2520b/');
  assert.equal(sig.canonicalUri('', false), '/');
});

test('header values are trimmed and runs of spaces collapse; a changed value changes the signature', () => {
  const base = Object.assign({ method: 'GET', url: 'https://example.amazonaws.com/', date: '20150830T123600Z' }, SUITE);
  const a = sig.signRequest(Object.assign({ headers: { 'My-Header1': '  a   b  ' } }, base));
  const b = sig.signRequest(Object.assign({ headers: { 'my-header1': 'a b' } }, base));
  const c = sig.signRequest(Object.assign({ headers: { 'my-header1': 'a  c' } }, base));
  assert.equal(a.signature, b.signature);
  assert.notEqual(a.signature, c.signature);
  assert.match(a.canonicalRequest, /\nmy-header1:a b\n/);
});

test('a presigned PUT can sign Content-Length so that the size is bound', () => {
  const o = Object.assign({ method: 'PUT', url: 'http://127.0.0.1:9000/bucket/staging/x.vmapp', date: '20260101T000000Z', expiresSec: 900 }, EXAMPLE);
  const a = sig.presign(Object.assign({ headers: { 'content-length': '1234' } }, o));
  const b = sig.presign(Object.assign({ headers: { 'content-length': '1235' } }, o));
  assert.match(a.url, /X-Amz-SignedHeaders=content-length%3Bhost/);
  assert.notEqual(a.signature, b.signature);
  assert.match(a.canonicalRequest, /\ncontent-length:1234\nhost:127\.0\.0\.1:9000\n\ncontent-length;host\nUNSIGNED-PAYLOAD$/);
  assert.throws(() => sig.presign(Object.assign({}, o, { expiresSec: 0 })), /expiresSec/);
  assert.throws(() => sig.presign(Object.assign({}, o, { expiresSec: 604801 })), /expiresSec/);
});

test('credentials are required and a session token is signed', () => {
  assert.throws(() => sig.signRequest({ method: 'GET', url: 'https://x.test/', region: 'r', service: 's3' }), /accessKeyId/);
  const r = sig.signRequest(Object.assign({ method: 'GET', url: 'https://x.test/k', date: '20260101T000000Z', sessionToken: 'TOKEN' }, EXAMPLE));
  assert.equal(r.headers['x-amz-security-token'], 'TOKEN');
  assert.match(r.signedHeaders, /x-amz-security-token/);
});
