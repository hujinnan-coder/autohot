-- 记录事件涉及的车型及其是否为特别重大节点。
ALTER TABLE stories ADD COLUMN product_key text, ADD COLUMN major_node boolean;
