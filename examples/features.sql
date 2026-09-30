-- ENUM, представления и комментарии — для проверки плагина.

CREATE TYPE order_status AS ENUM ('new', 'paid', 'shipped');
ALTER TYPE order_status ADD VALUE 'cancelled';
ALTER TYPE order_status ADD VALUE 'refunded' AFTER 'paid';
CREATE TYPE user_role AS ENUM ('student', 'teacher', 'admin');

CREATE TABLE users (
    id    SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    role  user_role NOT NULL DEFAULT 'student'
);

CREATE TABLE orders (
    id       SERIAL PRIMARY KEY,
    user_id  INTEGER NOT NULL REFERENCES users(id),
    status   order_status NOT NULL DEFAULT 'new',
    history  order_status[] NOT NULL DEFAULT '{}',
    total    NUMERIC(12,2) NOT NULL CHECK (total >= 0)
);

CREATE VIEW active_orders AS
    SELECT o.id, u.email, o.status, o.total
    FROM orders o
    JOIN users u ON u.id = o.user_id
    WHERE o.status NOT IN ('shipped', 'cancelled');

CREATE MATERIALIZED VIEW revenue_by_user AS
    SELECT u.id AS user_id, u.email, sum(o.total) AS revenue, count(*) AS orders
    FROM users u
    JOIN orders o ON o.user_id = u.id
    GROUP BY u.id, u.email;

COMMENT ON TYPE order_status IS 'Жизненный цикл заказа';
COMMENT ON TABLE users IS 'Пользователи сервиса';
COMMENT ON COLUMN users.role IS 'Роль определяет доступ к разделам';
COMMENT ON COLUMN orders.history IS 'Все статусы, через которые прошёл заказ';
COMMENT ON VIEW active_orders IS 'Заказы, которые ещё в работе';
COMMENT ON MATERIALIZED VIEW revenue_by_user IS 'Обновляется раз в сутки';
