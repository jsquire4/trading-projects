// Stub for the `usb` native addon.
// The real package requires libusb-1.0 headers and node-gyp compilation,
// which fails in Railway's Docker build environment.
// This stub is safe because usb is only used by @trezor/transport for
// Trezor hardware wallet support, which is not needed for web-only usage.
module.exports = {};
