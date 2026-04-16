ALTER TABLE public.products 
DROP CONSTRAINT IF EXISTS products_coating_check;

ALTER TABLE public.products 
ADD CONSTRAINT products_coating_check 
CHECK (coating IN (
  'без покрытия', 
  'НФ', 
  'АФ', 
  'ФА', 
  'ФТ', 
  'ФТ-У', 
  'AL', 
  'AL2', 
  'СТ', 
  'БТ', 
  'Ф',
  'НГ арм.базальтом'
));
