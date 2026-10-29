# moby·type

Read *Moby-Dick* by typing it out, monkeytype-style.

Open `index.html` in a browser. No build step and no server needed.

- Your progress, stats and mistakes save automatically in the browser (localStorage).
  Use **settings → export** to back them up.
- Curly quotes, em dashes and accented letters accept their plain-keyboard versions (`'`, `"`, `-`, `e`).
- At the end of a paragraph (¶), press Enter or Space.

`book.js` is generated from Project Gutenberg ebook #2701:

```sh
curl -L https://www.gutenberg.org/cache/epub/2701/pg2701.txt -o pg2701.txt
python3 tools/build_book.py pg2701.txt > book.js
```
