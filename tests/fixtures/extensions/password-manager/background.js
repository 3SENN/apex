// Fixture worker: nothing runs in unit tests (the fake adapter only reads the manifest).
chrome.runtime.onInstalled.addListener(() => {})
