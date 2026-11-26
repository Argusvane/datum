#!/bin/sh
# Makes a development PKCS#12 key store for the example's PDF seal: one RSA-2048 key and a self-signed certificate that
# may sign documents. The private key stays in the file this writes (local/dev-signer.p12 by default, which is
# gitignored); nothing here is committed and the certificate is trusted by nobody, so a PDF sealed with it verifies
# as "self-signed". A real server uses a key from its own CA (or a trust service) and keeps the store and its
# password out of the repository.
#
#   scripts/make-dev-keystore.sh [directory]        # default: the example's own local/ folder, wherever this runs from
#   KEYTOOL=/path/to/keytool PASSWORD=secret scripts/make-dev-keystore.sh
set -eu
dir="${1:-$(cd "$(dirname "$0")/.." && pwd)/local}"
# The password reaches keytool through the environment, never its command line (ps) or this script's output.
PASSWORD_VALUE="${PASSWORD:-changeit}"
export PASSWORD_VALUE
keytool="${KEYTOOL:-keytool}"
store="$dir/dev-signer.p12"
mkdir -p "$dir"
rm -f "$store"
"$keytool" -genkeypair -alias server -keyalg RSA -keysize 2048 -sigalg SHA256withRSA -validity 365 \
  -dname "CN=Datum example PDF signer, O=Datum examples, C=CA" \
  -ext "KeyUsage=digitalSignature,nonRepudiation" \
  -storetype PKCS12 -keystore "$store" -storepass:env PASSWORD_VALUE -keypass:env PASSWORD_VALUE >/dev/null
echo "Wrote $store (alias server)."
