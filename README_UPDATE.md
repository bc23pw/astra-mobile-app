Astra live self-learn update

Replace files:
- In astra-mobile-app: app.js and conversation_library_ru_en.json
- In astra-mobile-worker-src: src/index.js

What changed:
- richer phrase library for RU/EN
- stronger anti-repetition layer
- local memory snapshot sent with each request
- recurring people/places/sounds remembered as descriptions, not identities
- cloud replies can draw from style library and local memory
