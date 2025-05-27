"""
Simple Python example for testing the AI Debugger MCP Server

This script contains a simple function with a bug that can be debugged
using the AI Debugger MCP Server.
"""

def calculate_sum(numbers):
    """Calculate the sum of a list of numbers"""
    total = 0
    
    # Bug: Off-by-one error in the range
    for i in range(len(numbers) + 1):
        total += numbers[i]
    
    return total

def main():
    """Main function"""
    print("Starting example program...")
    
    numbers = [1, 2, 3, 4, 5]
    print(f"Numbers: {numbers}")
    
    # This will produce an error due to the bug
    try:
        result = calculate_sum(numbers)
        print(f"Sum: {result}")  # This won't be reached due to the IndexError
    except IndexError as e:
        print(f"Error occurred: {e}")
    
    print("Program completed.")

if __name__ == "__main__":
    main()