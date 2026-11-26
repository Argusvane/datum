git clone https://github.com/argusvane/datum.git
cd datum

npm run setup -- engine packages/quickjs-wasm-host packages/pdf-kernel packages/datum
npm run datum:build
