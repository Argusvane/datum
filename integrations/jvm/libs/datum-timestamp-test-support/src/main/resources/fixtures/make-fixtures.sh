#!/bin/sh
# Test fixtures for datum-timestamp, minted with openssl (3.x). Throwaway material with no trust anywhere:
# never use these keys outside the tests.
#
# Run from anywhere: sh integrations/jvm/libs/datum-timestamp-test-support/src/main/resources/fixtures/make-fixtures.sh
# The PEMs and the openssl-made reply are committed, so the unit tests need no openssl; OpensslRoundTripIT
# makes its own keys and requests at run time.
#
# tsa.cert.pem, tsa.key.pem and tsa.cnf are copies of packages/pdf-kernel/tests/fixtures/signing/ (the
# kernel's TSA fixture, RSA-2048, EKU timeStamping critical); this script does not touch them.
set -eu
cd "$(dirname "$0")"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# One config, a section per certificate shape. The good shape is the one SelfSignedTsaCertificate writes (RFC 3161 section 2.3):
# basicConstraints critical CA:FALSE, extendedKeyUsage critical timeStamping.
cat > "$work/req.cnf" <<'EOF'
[ req ]
distinguished_name = dn
prompt = no
[ dn ]
[ tsa ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,nonRepudiation
extendedKeyUsage = critical,timeStamping
subjectKeyIdentifier = hash
[ eku_not_critical ]
basicConstraints = critical,CA:FALSE
extendedKeyUsage = timeStamping
[ eku_extra ]
basicConstraints = critical,CA:FALSE
extendedKeyUsage = critical,timeStamping,codeSigning
[ no_eku ]
basicConstraints = critical,CA:FALSE
EOF

# make <name> <section> <subject> <newkey args...>: a self-signed certificate valid for a century, so the
# committed fixtures never expire under the tests.
make() {
  name=$1; section=$2; subject=$3; shift 3
  openssl req -x509 -config "$work/req.cnf" -extensions "$section" -newkey "$@" -nodes \
    -keyout "$name.key.pem" -out "$name.cert.pem" -days 36500 -subj "$subject" 2>/dev/null
}

make ec-p256 tsa '/O=Datum tests/CN=Datum test TSA ec' ec -pkeyopt ec_paramgen_curve:prime256v1
make ec-p384 tsa '/O=Datum tests/CN=Datum test TSA p384' ec -pkeyopt ec_paramgen_curve:secp384r1
make rsa-2048 tsa '/O=Datum tests/CN=Datum test TSA rsa' rsa:2048
# Refused for a timestamp server: the key (RSA under 2048 bits, a curve other than P-256/P-384) or the
# extended key usage (not critical, not timeStamping alone, absent).
make rsa-1024 tsa '/O=Datum tests/CN=Small RSA' rsa:1024
make ec-p521 tsa '/O=Datum tests/CN=P-521' ec -pkeyopt ec_paramgen_curve:secp521r1
make eku-not-critical eku_not_critical '/O=Datum tests/CN=EKU not critical' ec -pkeyopt ec_paramgen_curve:prime256v1
make eku-extra eku_extra '/O=Datum tests/CN=EKU with code signing' ec -pkeyopt ec_paramgen_curve:prime256v1
make no-eku no_eku '/O=Datum tests/CN=No usage at all' ec -pkeyopt ec_paramgen_curve:prime256v1

# The openssl-made reply TimestampTokenTest reads: the kernel's opensslTimestamp() (packages/pdf-kernel/tests/
# signing-fixtures.ts) run over a request for "openssl reply data" (SHA-256, a nonce, the certificate asked for).
printf 'openssl reply data' > "$work/data.txt"
openssl ts -query -data "$work/data.txt" -sha256 -cert -out openssl-query.tsq
cp tsa.cert.pem tsa.key.pem "$work/"
sed 's/^dir = .*/dir = ./' tsa.cnf > "$work/tsa.cnf"
printf '01\n' > "$work/tsa.serial"
cp openssl-query.tsq "$work/request.tsq"
(cd "$work" && openssl ts -reply -config tsa.cnf -queryfile request.tsq -out reply.tsr 2>/dev/null)
cp "$work/reply.tsr" openssl-reply.tsr
echo "fixtures written to $(pwd)"
