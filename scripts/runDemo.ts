import { runDemo } from '../src/demo/demoRunner';

runDemo().catch((error) => {
  console.error(error);
  process.exit(1);
});
