## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b my-feature`
3. Test your changes with `/tokens --debug` to verify data flow
4. Ensure TypeScript compiles without errors
5. Submit a pull request

### Development Notes

- Output uses **Unicode Mathematical Alphanumeric Symbols** for bold text (no ANSI, no markdown)
- All sections share a **unified column width** (computed from the longest label across all sections)
- Only **SKILLS** and **TOOLS** sections show a TOTAL line
- Debug mode is enabled ONLY by passing the exact argument `--debug` — no flag matching, no config files
