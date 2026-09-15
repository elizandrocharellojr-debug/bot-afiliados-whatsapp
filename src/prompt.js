import { createInterface } from 'node:readline';

// Nem readline/promises nem rl.question() classico sao confiaveis quando
// varias linhas chegam bufferizadas de uma vez no stdin (confirmado
// testando - a 2a pergunta em diante pode ficar esperando pra sempre).
// Por isso montamos uma fila propria: cada linha que chega vira um item
// na fila ou resolve quem estiver esperando, na ordem certa.
export function createPrompt() {
  const rl = createInterface({ input: process.stdin });
  const queue = [];
  const waiters = [];

  rl.on('line', (line) => {
    if (waiters.length > 0) {
      waiters.shift()(line);
    } else {
      queue.push(line);
    }
  });

  function ask(question) {
    process.stdout.write(question);
    if (queue.length > 0) {
      return Promise.resolve(queue.shift());
    }
    return new Promise((resolve) => waiters.push(resolve));
  }

  return { ask, close: () => rl.close() };
}
