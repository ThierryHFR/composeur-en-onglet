# Thunderbird Tab Composer

A modern tab-based email composer for Thunderbird.

This extension provides an alternative compose experience directly inside a Thunderbird tab, with a modern rich text editor, address book integration, direct sending support, attachments, emojis, multilingual UI, and more.

## Features

- Compose emails in a Thunderbird tab
- Rich text editor
- Bold, italic, underline, colors, lists
- Link and image insertion
- Emoji picker
- File attachments
- Direct send support
- Address book integration
- Recipient deduplication
- Multilingual interface
  - French
  - English
  - German
  - Italian
  - Spanish
- Spell checking while typing
- Automatic form reset after sending

## Screenshots

_Add screenshots here_

## Installation

1. Download the latest `.xpi`
2. Open Thunderbird
3. Go to:
   - `Add-ons and Themes`
4. Click:
   - `Install Add-on From File`
5. Select the `.xpi`

## Thunderbird Configuration

To disable the blocking spell-check dialog before sending:

1. Open Thunderbird settings
2. Open the configuration editor
3. Set:

```text
mail.SpellCheckBeforeSend = false
```

Spell checking while typing will remain active.

## Development

The extension is built using Thunderbird MailExtension APIs.

Main technologies:
- HTML
- CSS
- JavaScript
- Thunderbird WebExtension APIs

## License

GPL3 License
