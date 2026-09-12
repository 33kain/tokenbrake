# Nimbus — demo marketing site

A standalone, static five-page marketing site built for presentation only. It
is unrelated to the tokenbrake tool and is kept in its own folder.

## Pages

| File           | Page                         |
| -------------- | ---------------------------- |
| `index.html`   | Home / landing               |
| `features.html`| Features                     |
| `pricing.html` | Pricing (monthly + team)     |
| `about.html`   | About                        |
| `login.html`   | Log in / sign up             |

Shared assets: `styles.css` (design system) and `main.js` (nav, pricing
toggle, auth tabs).

## Notes

- **Nimbus** is an invented product; the company, team, and figures are
  illustrative placeholders.
- No call to action is wired to a backend — buttons and forms are for the
  look and feel only. The login and signup forms do not submit.

## Viewing

Open `index.html` in a browser, or serve the folder:

```bash
cd marketing-site
python3 -m http.server 8000   # then visit http://localhost:8000
```
