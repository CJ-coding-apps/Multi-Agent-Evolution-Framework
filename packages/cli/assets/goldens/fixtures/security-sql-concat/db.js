function findUser(db, name){
  return db.query('SELECT * FROM users WHERE name = \'' + name + '\'');
}
module.exports={findUser};
