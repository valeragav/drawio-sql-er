-- MySQL (в стиле mysqldump) — для проверки плагина.
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
SET NAMES utf8mb4;

DROP TABLE IF EXISTS `Users`;
CREATE TABLE `Users` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `email` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Логин',
  `role` enum('student','teacher','admin') NOT NULL DEFAULT 'student',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_email` (`email`),
  KEY `idx_users_role` (`role`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4 COMMENT='Пользователи';

# заказы
CREATE TABLE `Orders` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` int unsigned NOT NULL,
  `total` decimal(12,2) NOT NULL DEFAULT '0.00',
  `note` text,
  PRIMARY KEY (`id`),
  KEY `fk_orders_user` (`user_id`),
  FULLTEXT KEY `ft_orders_note` (`note`),
  CONSTRAINT `fk_orders_user` FOREIGN KEY (`user_id`) REFERENCES `Users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

LOCK TABLES `Orders` WRITE;
INSERT INTO `Orders` VALUES (1,1,10.00,'a; b');
UNLOCK TABLES;

ALTER TABLE `Orders` ADD INDEX `idx_orders_total` (`total`);
