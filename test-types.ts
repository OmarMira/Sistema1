import * as React from 'react';

// What works as Button prop type?
type BtnJSX = React.JSX.IntrinsicElements['button'];

// Does BtnJSX include onClick?
type Resolved = {
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  children?: React.ReactNode;
};

// Test if BtnJSX can be used as prop type  
const test1: BtnJSX = { onClick: () => {} }; // should work
const test2: BtnJSX = { disabled: true };     // should work
