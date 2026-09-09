CREATE TABLE customers (
  customer_id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL,
  monthly_fee REAL NOT NULL,
  joined_on TEXT NOT NULL,
  is_active INTEGER NOT NULL
) STRICT;
