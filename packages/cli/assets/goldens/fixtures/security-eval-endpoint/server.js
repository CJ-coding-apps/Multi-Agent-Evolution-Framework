const express=require('express');const app=express();
app.get('/run',(req,res)=>{ res.send(String(eval(req.query.code))); });
app.listen(3000);
