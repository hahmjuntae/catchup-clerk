import { mkdir, cp } from 'node:fs/promises';
await mkdir(new URL('../public/core/',import.meta.url),{recursive:true});
await mkdir(new URL('../public/fixtures/',import.meta.url),{recursive:true});
await cp(new URL('../src/core/',import.meta.url),new URL('../public/core/',import.meta.url),{recursive:true});
await cp(new URL('../fixtures/demo-stream.json',import.meta.url),new URL('../public/fixtures/demo-stream.json',import.meta.url));
console.log('Shared core and demo fixture copied to public assets.');
