/** The two web components Atlas defines at runtime, declared so JSX accepts them. */
declare namespace React.JSX {
  interface IntrinsicElements {
    'atlas-open-badge': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    'atlas-closed-badge': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
  }
}
