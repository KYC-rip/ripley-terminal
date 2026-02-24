const fs = require('fs');
const path = require('path');

const walk = (dir, done) => {
  let results = [];
  fs.readdir(dir, (err, list) => {
    if (err) return done(err);
    let i = 0;
    (function next() {
      let file = list[i++];
      if (!file) return done(null, results);
      file = path.resolve(dir, file);
      fs.stat(file, (err, stat) => {
        if (stat && stat.isDirectory()) {
          walk(file, (err, res) => {
            results = results.concat(res);
            next();
          });
        } else {
          results.push(file);
          next();
        }
      });
    })();
  });
};

const map = {
  'text-\\[7px\\]': 'text-[9px]',
  'text-\\[8px\\]': 'text-[10px]',
  'text-\\[9px\\]': 'text-[11px]',
  'text-\\[10px\\]': 'text-xs' // text-xs is 12px
};

walk('/Users/anton/Projects/kyc-rip/desktop/src/renderer', (err, results) => {
  if (err) throw err;

  results.filter(f => f.endsWith('.tsx') || f.endsWith('.ts')).forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    let changed = false;

    for (const [regex, replacement] of Object.entries(map)) {
      const re = new RegExp(regex, 'g');
      if (re.test(content)) {
        content = content.replace(re, replacement);
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(file, content, 'utf8');
      console.log(`Updated: ${file}`);
    }
  });
  console.log('Complete!');
});
