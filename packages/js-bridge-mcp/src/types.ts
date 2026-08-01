export interface HelloState {
  title: string;
  main: string;
}

export const initialHelloState: HelloState = {
  title: 'Hello, world!',
  main: 'Waiting for an agent to say something...',
};
