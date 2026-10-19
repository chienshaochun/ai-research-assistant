# Third-party notices

This personal, noncommercial project links to OpenAI's Sign in with ChatGPT DevKit from `vendor/sign-in-with-chatgpt-devkit`.

The DevKit's source, license, notices, and dependency inventory are preserved in that directory. OpenAI-authored DevKit code is provided under the Sign-in with ChatGPT DevKit Noncommercial License v1.0. OpenAI names, trademarks, logos, branded assets, and services are governed separately.

The Electron credential-encryption adapter in this project is adapted from the DevKit's Paste Perfect example and retains the same security boundary: it uses Electron `safeStorage` in the trusted main process and has no plaintext fallback.
