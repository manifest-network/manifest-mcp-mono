import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';

// Call assertVerifiedProvenance only with the JSON output of a successful local
// `npm audit signatures --json --include-attestations`. npm performs cryptographic
// verification; this module applies identity policy to those exact verified bytes.
export function assertProvenanceStatement(statement, expected) {
  assert.equal(
    statement.predicateType,
    'https://slsa.dev/provenance/v1',
    'Expected SLSA v1 provenance',
  );
  assert.equal(statement._type, 'https://in-toto.io/Statement/v1');
  const digest = Buffer.from(
    expected.integrity.replace(/^sha512-/, ''),
    'base64',
  ).toString('hex');
  assert.match(expected.integrity, /^sha512-/);
  assert.deepEqual(
    statement.subject,
    [
      {
        name: `pkg:npm/${expected.name.replace(/^@/, '%40')}@${expected.version}`,
        digest: { sha512: digest },
      },
    ],
    'Provenance subject must match the exact packed artifact',
  );
  const definition = statement.predicate?.buildDefinition;
  assert.equal(
    definition?.buildType,
    'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
  );
  assert.deepEqual(
    definition.externalParameters?.workflow,
    {
      ref: expected.ref,
      repository: `https://github.com/${expected.repository}`,
      path: expected.workflow,
    },
    'Wrong provenance workflow identity',
  );
  assert.ok(
    definition.resolvedDependencies?.some(
      (dependency) =>
        dependency.uri ===
          `git+https://github.com/${expected.repository}@${expected.ref}` &&
        dependency.digest?.gitCommit === expected.sha,
    ),
    'Provenance must identify the reviewed full source commit',
  );
  assert.equal(
    statement.predicate.runDetails?.builder?.id,
    'https://github.com/actions/runner/github-hosted',
  );
}

// Parse bounded DER TLVs solely to read Fulcio certificate extensions. X509Certificate
// validates the certificate structure; npm/Sigstore validates its chain and signature.
function derElement(bytes, offset = 0) {
  assert.ok(offset + 2 <= bytes.length, 'Truncated DER element');
  const tag = bytes[offset++];
  assert.notEqual(tag & 0x1f, 0x1f, 'Unsupported high-tag DER encoding');
  let length = bytes[offset++];
  if (length & 0x80) {
    const count = length & 0x7f;
    assert.ok(
      count > 0 && count <= 4 && offset + count <= bytes.length,
      'Invalid DER length',
    );
    assert.notEqual(bytes[offset], 0, 'Non-canonical DER length');
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[offset++];
    assert.ok(length >= 128, 'Non-canonical long DER length');
  }
  assert.ok(offset + length <= bytes.length, 'Truncated DER value');
  return {
    tag,
    value: bytes.subarray(offset, offset + length),
    end: offset + length,
  };
}
function derChildren(bytes) {
  const children = [];
  for (let offset = 0; offset < bytes.length; ) {
    const entry = derElement(bytes, offset);
    children.push(entry);
    offset = entry.end;
  }
  return children;
}

export function assertProvenanceCertificate(rawBytes, expected) {
  const certificate = new X509Certificate(Buffer.from(rawBytes, 'base64'));
  assert.equal(
    certificate.subjectAltName,
    `URI:https://github.com/${expected.repository}/${expected.workflow}@${expected.ref}`,
    'Verified signing certificate must identify the expected GitHub workflow',
  );
  const outer = derElement(certificate.raw);
  assert.equal(outer.tag, 0x30);
  assert.equal(outer.end, certificate.raw.length);
  const [tbs] = derChildren(outer.value);
  assert.equal(tbs.tag, 0x30);
  const extensionContainers = derChildren(tbs.value).filter(
    (entry) => entry.tag === 0xa3,
  );
  assert.equal(
    extensionContainers.length,
    1,
    'Expected one certificate extension container',
  );
  const extensions = extensionContainers[0];
  const sequence = derElement(extensions.value);
  assert.equal(sequence.tag, 0x30);
  assert.equal(sequence.end, extensions.value.length);
  const values = new Map();
  for (const extension of derChildren(sequence.value)) {
    assert.equal(extension.tag, 0x30);
    const entries = derChildren(extension.value);
    assert.ok(entries.length === 2 || entries.length === 3);
    assert.equal(entries[0].tag, 0x06);
    if (entries.length === 3) assert.equal(entries[1].tag, 0x01);
    const value = entries.at(-1);
    assert.equal(value.tag, 0x04);
    const oid = entries[0].value.toString('hex');
    assert.ok(!values.has(oid), 'Duplicate certificate extension');
    values.set(oid, value.value);
  }
  // Fulcio v2: 1.3.6.1.4.1.57264.1.{8,12,13,14}. These are authenticated
  // certificate fields, unlike claims that only appear inside a signed payload.
  for (const [suffix, expectedValue] of [
    [8, 'https://token.actions.githubusercontent.com'],
    [12, `https://github.com/${expected.repository}`],
    [13, expected.sha],
    [14, expected.ref],
  ]) {
    const bytes = values.get(
      `2b0601040183bf3001${suffix.toString(16).padStart(2, '0')}`,
    );
    assert.ok(bytes, `Missing Fulcio identity extension ${suffix}`);
    const value = derElement(bytes);
    assert.equal(value.tag, 0x0c, 'Expected a UTF8 identity extension');
    assert.equal(value.end, bytes.length);
    assert.equal(
      value.value.toString('utf8'),
      expectedValue,
      `Wrong Fulcio identity extension ${suffix}`,
    );
  }
}

export function assertVerifiedProvenance(audit, expected) {
  assert.deepEqual(audit.invalid, [], 'npm reported invalid signatures');
  assert.deepEqual(
    audit.missing,
    [],
    'npm reported missing registry signatures',
  );
  const verified = audit.verified?.filter(
    (entry) =>
      entry.name === expected.name && entry.version === expected.version,
  );
  assert.ok(
    verified?.length,
    "Expected package is absent from npm's verified results",
  );
  const statements = [];
  for (const entry of verified) {
    assert.equal(entry.registry, 'https://registry.npmjs.org/');
    const provenance = entry.attestationBundles?.filter(
      (item) => item.predicateType === 'https://slsa.dev/provenance/v1',
    );
    assert.equal(
      provenance?.length,
      1,
      'Expected exactly one cryptographically verified provenance bundle',
    );
    const bundle = provenance[0].bundle;
    const rawBytes =
      bundle.verificationMaterial?.certificate?.rawBytes ??
      bundle.verificationMaterial?.x509CertificateChain?.certificates?.[0]
        ?.rawBytes;
    assert.ok(
      rawBytes,
      'Provenance requires a verified Fulcio signing certificate',
    );
    assertProvenanceCertificate(rawBytes, expected);
    assert.equal(
      bundle.dsseEnvelope?.payloadType,
      'application/vnd.in-toto+json',
    );
    const statement = JSON.parse(
      Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8'),
    );
    assertProvenanceStatement(statement, expected);
    statements.push(statement);
  }
  return statements;
}
