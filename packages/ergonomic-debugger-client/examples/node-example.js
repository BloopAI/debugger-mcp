/**
 * Simple Node.js example for testing the AI Debugger MCP Server
 *
 * This script contains a simple function with a bug that can be debugged
 * using the AI Debugger MCP Server.
 */

// Function with a bug
function calculateSum(numbers) {
  let sum = 0;

  // Bug: Off-by-one error in the loop
  for (let i = 0; i <= numbers.length; i++) {
    sum += numbers[i];
  }

  return sum;
}

// Main function
function main() {
  console.log('Starting example program...');

  const numbers = [1, 2, 3, 4, 5];
  console.log('Numbers:', numbers);

  // This will produce an incorrect result due to the bug
  const result = calculateSum(numbers);
  console.log('Sum:', result); // Expected: 15, Actual: NaN (due to accessing undefined)

  console.log('Program completed.');
}

// Run the main function
main();
