# Split the bill — kane-loop flows
> The spec for the demo app. Every "## heading" is one Kane CLI run in a real Chrome.
> The app in ./app starts as an empty page; the coding agent builds it only from Kane's failures.

url: http://127.0.0.1:4173/
max-steps: 25

## even split
Enter 90 as the bill amount, 3 as the number of people and 0 as the tip percent, then verify the page shows that each person pays 30.00

## tip is added before splitting
Enter 100 as the bill amount, 4 as the number of people and 10 as the tip percent, then verify the page shows a total of 110.00 and that each person pays 27.50

## cents add up exactly
Enter 100 as the bill amount, 3 as the number of people and 0 as the tip percent, then verify the page lists what each of the 3 people pays and that those three amounts add up to exactly 100.00, with no person paying 33.33 three times

## zero people is rejected
Enter 50 as the bill amount and 0 as the number of people, then verify the page shows an error message saying at least 1 person is needed and does not show any per-person amount
