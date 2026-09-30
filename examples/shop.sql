-- Небольшой пример для проверки плагина: вставьте содержимое в окно «Из SQL».

CREATE TABLE customers (
    id          BIGSERIAL PRIMARY KEY,
    email       VARCHAR(255) NOT NULL UNIQUE,
    full_name   TEXT NOT NULL,
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE TABLE categories (
    id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    name       TEXT NOT NULL
);

CREATE TABLE products (
    id           SERIAL PRIMARY KEY,
    category_id  INTEGER NOT NULL REFERENCES categories(id),
    title        TEXT NOT NULL,
    price        NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
    tags         TEXT[] NOT NULL DEFAULT '{}'::text[]
);

CREATE TABLE orders (
    id           SERIAL PRIMARY KEY,
    customer_id  BIGINT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'paid', 'shipped')),
    CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
);

CREATE TABLE order_items (
    order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id  INTEGER NOT NULL REFERENCES products(id),
    quantity    INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (order_id, product_id)
);

CREATE TABLE invoices (
    order_id  INTEGER PRIMARY KEY REFERENCES orders(id),
    total     NUMERIC(12, 2) NOT NULL
);

CREATE INDEX idx_products_category_id ON products (category_id);
CREATE INDEX idx_products_tags ON products USING gin (tags);
CREATE UNIQUE INDEX idx_customers_email_lower ON customers (lower(email));
CREATE INDEX idx_orders_active ON orders (customer_id) WHERE status <> 'shipped';
