# SourceMod AI Assistant (Gemini 2.5 Pro + Tool-Calling)

a lightweight web app that helps you make SourceMod plugins. it uses Gemini tool-calling with a local JSON copy of the SourceMod API parsed from version 1.12. the parser is included in the `parser` directory. this repo serves as an archive. to run this for free make a copy of the app in the **the google AI studio link below**.  

sourcemod api reference is generated from sourcemod build 1.12.

## unlimited 2.5 pro for free

ai studio offers an unlimited free default API key for both 2.5 pro and 2.5 flash.

test or fork the app AI Studio Build: https://ai.studio/apps/drive/1LDELwdxhSsSZrf-C2RhofEhY1KqbS7nl

## settings

i would recommend the following settings

  - Temperature: `0.3`
  - Top-p: `0.9`

for the model, flash produces more quick code and fails less. pro is better for more complex stuff.

## data files

the app expects these files at runtime:

* `sourcemod_api.json` your parsed SourceMod API reference (already integrated).
* `system_prompt.json` system prompt used by the assistant (already integrated).

## /parser

parse all sourcemod .inc files inside a directory into the json schema.

* `parser/inc_to_json.py` builds sourcemod API JSON schema for all `.inc` files in a directory.
    - args: `py inc_to_json.py ./inc_folder --output ./file.json`


## run locally

**prerequisites:**  Node.js

1. install dependencies:
   `npm install`
2. set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. run the app:
   `npm run dev`
